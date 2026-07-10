/**
 * Cloudflare Worker 入口 - EasyTier WSS 中继
 *
 * 接受 EasyTier 节点的 WebSocket 连接（ws:// 或 wss://），
 * 校验私有模式的 network-name 和 network-secret，
 * 然后将连接交给对应的 Durable Object 实例进行中继转发。
 *
 * 鉴权方式（二选一）：
 *   1. URL 查询参数: wss://relay.example.com/?name=xxx&secret=xxx
 *   2. 自定义 Header: X-Network-Name / X-Network-Secret
 *
 * EasyTier 客户端连接示例:
 *   easytier-core --network-name abc --network-secret abc \
 *     -p wss://your-worker.example.workers.dev/?name=abc&secret=abc
 */

export { EasyTierRelayDO } from "./relay.js";

/** @typedef {{ networkName: string, networkSecret: string }} AuthInfo */

/**
 * 从请求中提取鉴权信息
 * @param {Request} request
 * @returns {AuthInfo | null}
 */
function extractAuth(request) {
  const url = new URL(request.url);

  // 方式1: URL 查询参数
  let networkName = url.searchParams.get("name");
  let networkSecret = url.searchParams.get("secret");

  // 方式2: 自定义 Header（查询参数不存在时使用）
  if (!networkName) {
    networkName = request.headers.get("X-Network-Name");
  }
  if (!networkSecret) {
    networkSecret = request.headers.get("X-Network-Secret");
  }

  if (!networkName || !networkSecret) {
    return null;
  }

  return { networkName, networkSecret };
}

/**
 * 检查是否为 WebSocket 升级请求
 * @param {Request} request
 */
function isWebSocketRequest(request) {
  return request.headers.get("Upgrade") === "websocket";
}

/**
 * 获取或创建 DO 实例的 stub
 * 每个 network-name 对应一个独立的 DO 实例
 * @param {DurableObjectNamespace} namespace
 * @param {string} networkName
 */
function getRelayStub(namespace, networkName) {
  // 用 network-name 作为 DO 的 ID 标识，相同网络的节点路由到同一实例
  const id = namespace.idFromName(networkName);
  return namespace.get(id);
}

export default {
  /**
   * @param {Request} request
   * @param {{ EASYTIER_RELAY: DurableObjectNamespace, DEBUG_LOG?: string }} env
   * @param {ExecutionContext} ctx
   */
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // 健康检查端点
    if (url.pathname === "/health" || url.pathname === "/") {
      return new Response(
        JSON.stringify({
          service: "cf-easytier-relay",
          status: "ok",
          version: "1.0.0",
          protocols: ["ws", "wss"],
          docs: "https://github.com/EasyTier/Easytier",
        }),
        {
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    // WebSocket 连接处理
    if (isWebSocketRequest(request)) {
      const auth = extractAuth(request);
      if (!auth) {
        return new Response(
          JSON.stringify({
            error: "missing network name or secret",
            hint: "provide ?name=xxx&secret=xxx as query params, or X-Network-Name / X-Network-Secret headers",
          }),
          { status: 401, headers: { "Content-Type": "application/json" } },
        );
      }

      // 获取 DO 实例
      const stub = getRelayStub(env.EASYTIER_RELAY, auth.networkName);

      // 转发请求到 DO，DO 内部完成 WebSocket 升级和鉴权
      // 将鉴权信息通过自定义 header 传给 DO
      const doRequest = new Request(request, {
        headers: {
          ...Object.fromEntries(request.headers),
          "X-Network-Name": auth.networkName,
          "X-Network-Secret": auth.networkSecret,
        },
      });

      return stub.fetch(doRequest);
    }

    // 非 WebSocket 请求，返回简单说明页面
    return new Response(
      `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>EasyTier Relay</title></head>
<body style="font-family: monospace; max-width: 720px; margin: 40px auto; line-height: 1.6;">
<h1>EasyTier WSS Relay</h1>
<p>This is a Cloudflare Worker that relays EasyTier WebSocket tunnel traffic.</p>
<h3>Connect your EasyTier node:</h3>
<pre>easytier-core --network-name &lt;name&gt; --network-secret &lt;secret&gt; \\
  -p wss://${url.host}/?name=&lt;name&gt;&amp;secret=&lt;secret&gt;</pre>
<h3>Endpoints:</h3>
<ul>
  <li><code>/</code> or <code>/health</code> - this page</li>
  <li><code>/status</code> - relay status (via DO)</li>
  <li><code>WebSocket upgrade</code> - relay tunnel</li>
</ul>
</body>
</html>`,
      { headers: { "Content-Type": "text/html; charset=utf-8" } },
    );
  },
};
