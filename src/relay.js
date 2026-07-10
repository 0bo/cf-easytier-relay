/**
 * EasyTierRelayDO - Durable Object 中继核心
 *
 * 每个 DO 实例对应一个 EasyTier 虚拟网络（由 network-name 标识）。
 * 同一网络内的所有 WebSocket 连接在此汇聚，二进制消息被广播给其他所有连接，
 * 从而充当 EasyTier 的共享中继节点。
 *
 * EasyTier WebSocket 隧道上传输的是二进制 Message，内容为 ZCPacket 的
 * tunnel_payload_bytes。WebSocket 自身有帧边界，所以中继只需原样转发二进制帧，
 * 无需解析 EasyTier 内部的 TCP 帧头 / PeerManagerHeader 等结构。
 *
 * 使用 Hibernatable WebSockets API 以降低 DO 空闲时的计费。
 */

export class EasyTierRelayDO {
  /**
   * @param {DurableObjectState} state
   * @param {{ DEFAULT_NETWORK_NAME?: string, DEFAULT_NETWORK_SECRET?: string, MAX_CONNECTIONS_PER_INSTANCE?: string, IDLE_TIMEOUT_SECONDS?: string, DEBUG_LOG?: string }} env
   */
  constructor(state, env) {
    this.state = state;
    this.env = env;

    /** @type {Map<WebSocket, { id: string, connectedAt: number, lastActivity: number, networkName: string }>} */
    this.sessions = new Map();

    this.maxConnections = parseInt(env.MAX_CONNECTIONS_PER_INSTANCE || "128", 10);
    this.idleTimeoutMs = parseInt(env.IDLE_TIMEOUT_SECONDS || "300", 10) * 1000;
    this.debug = env.DEBUG_LOG === "true";

    this._cleanupAlarmSet = false;
  }

  /**
   * DO 入口：处理来自 Worker 的请求
   * - WebSocket 升级请求 -> 接受连接并加入中继池
   * - GET /status -> 返回当前连接状态
   *
   * @param {Request} request
   */
  async fetch(request) {
    const url = new URL(request.url);

    // 状态查询
    if (url.pathname === "/status") {
      return new Response(
        JSON.stringify(this._getStatus()),
        { headers: { "Content-Type": "application/json" } },
      );
    }

    // WebSocket 升级
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected WebSocket", { status: 426 });
    }

    // 从 Worker 传入的 header 中提取鉴权信息
    const networkName = request.headers.get("X-Network-Name");
    const networkSecret = request.headers.get("X-Network-Secret");

    // 私有模式鉴权
    if (
      !networkName ||
      !networkSecret ||
      networkName !== this.env.DEFAULT_NETWORK_NAME ||
      networkSecret !== this.env.DEFAULT_NETWORK_SECRET
    ) {
      if (this.debug) {
        console.log(`[relay] auth failed: name=${networkName}`);
      }
      // 即使鉴权失败也要返回 WebSocket 响应，然后立即关闭
      const pair = new WebSocketPair();
      pair[1].accept();
      pair[1].close(4001, "auth failed");
      return new Response(null, { status: 101, webSocket: pair[1] });
    }

    // 连接数上限检查
    if (this.sessions.size >= this.maxConnections) {
      const pair = new WebSocketPair();
      pair[1].accept();
      pair[1].close(1013, "max connections reached");
      return new Response(null, { status: 101, webSocket: pair[1] });
    }

    // 创建 WebSocket 对
    const pair = new WebSocketPair();
    const clientWs = pair[1];  // 给客户端的端
    const serverWs = pair[0];  // DO 内部使用的端

    // 使用 Hibernatable WebSocket：让 DO 可以休眠以节省计费
    this.state.acceptWebSocket(serverWs);

    const sessionId = crypto.randomUUID();
    const now = Date.now();

    this.sessions.set(serverWs, {
      id: sessionId,
      connectedAt: now,
      lastActivity: now,
      networkName,
    });

    if (this.debug) {
      console.log(
        `[relay] session connected: ${sessionId}, total: ${this.sessions.size}`,
      );
    }

    // 确保空闲清理 alarm 已设置
    await this._ensureCleanupAlarm();

    // 返回 WebSocket 升级响应
    return new Response(null, { status: 101, webSocket: clientWs });
  }

  // ── Hibernatable WebSocket 回调 ──────────────────────────

  /**
   * 收到二进制/文本消息
   * @param {WebSocket} ws - DO 内部端
   * @param {ArrayBuffer | string} message
   */
  async webSocketMessage(ws, message) {
    let session = this.sessions.get(ws);

    // 休眠恢复后 sessions 可能已清空，重建最小会话记录
    if (!session) {
      session = {
        id: crypto.randomUUID(),
        connectedAt: Date.now(),
        lastActivity: Date.now(),
        networkName: this.env.DEFAULT_NETWORK_NAME,
      };
      this.sessions.set(ws, session);
    }

    session.lastActivity = Date.now();

    // EasyTier 只使用二进制帧；忽略文本帧
    if (typeof message === "string") return;

    // 将二进制消息转发给同网络内的所有其他连接
    const data = message;
    let forwarded = 0;
    const dead = [];

    for (const [peerWs, peerSession] of this.sessions) {
      if (peerWs === ws) continue;
      if (peerSession.networkName !== session.networkName) continue;
      try {
        peerWs.send(data);
        forwarded++;
      } catch (e) {
        dead.push(peerWs);
      }
    }

    // 清理发送失败的连接
    for (const deadWs of dead) {
      this._closeSession(deadWs);
    }

    if (this.debug && forwarded > 0) {
      console.log(
        `[relay] session ${session.id} -> ${forwarded} peers`,
      );
    }
  }

  /**
   * WebSocket 关闭
   */
  async webSocketClose(ws, code, reason) {
    this._closeSession(ws);
    if (this.debug) {
      console.log(
        `[relay] session closed: code=${code}, total: ${this.sessions.size}`,
      );
    }
  }

  /**
   * WebSocket 错误
   */
  async webSocketError(ws, error) {
    if (this.debug) {
      console.log(`[relay] session error: ${error.message}`);
    }
    this._closeSession(ws);
  }

  // ── 内部方法 ──────────────────────────────────────────

  /**
   * 关闭并清理单个会话
   * @param {WebSocket} ws
   */
  _closeSession(ws) {
    this.sessions.delete(ws);
    try {
      ws.close();
    } catch (_) {
      // 忽略
    }
  }

  /**
   * 获取当前状态
   */
  _getStatus() {
    return {
      connectedSessions: this.sessions.size,
      maxConnections: this.maxConnections,
      networkName: this.env.DEFAULT_NETWORK_NAME,
    };
  }

  /**
   * 设置空闲清理 alarm
   * DO 的 alarm API 比 setInterval 更可靠，且与 Hibernatable WS 兼容
   */
  async _ensureCleanupAlarm() {
    if (this._cleanupAlarmSet) return;
    await this.state.storage.setAlarm(
      Date.now() + 60_000, // 1 分钟后检查
    );
    this._cleanupAlarmSet = true;
  }

  /**
   * Alarm 触发：清理空闲连接，如有活跃连接则继续设置下一次 alarm
   */
  async alarm() {
    this._cleanupAlarmSet = false;
    const now = Date.now();
    const dead = [];

    for (const [ws, session] of this.sessions) {
      if (now - session.lastActivity > this.idleTimeoutMs) {
        dead.push(ws);
      }
    }

    for (const ws of dead) {
      if (this.debug) {
        const s = this.sessions.get(ws);
        console.log(`[relay] idle timeout: ${s?.id}`);
      }
      this._closeSession(ws);
    }

    // 还有活跃连接就继续设置清理 alarm
    if (this.sessions.size > 0) {
      await this._ensureCleanupAlarm();
    }
  }
}
