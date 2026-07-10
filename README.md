# cf-easytier-relay

利用 **Cloudflare Workers + Durable Objects** 部署 [EasyTier](https://github.com/EasyTier/Easytier) 共享中继节点，支持**私有模式**。

## 工作原理

```
EasyTier 节点 A ──┐                          ┌── EasyTier 节点 B
                  ├── Cloudflare Worker (WSS) ──┤
EasyTier 节点 C ──┘   Durable Object 中继      └── EasyTier 节点 D
```

- EasyTier 节点通过 `wss://` 或 `ws://` WebSocket 协议连接到 Cloudflare Worker
- Worker 使用 Durable Objects (DO) 维护有状态的 WebSocket 连接池
- DO 将同一虚拟网络内的二进制消息互相转发，充当中继节点
- 私有模式鉴权：只有提供正确 `network-name` 和 `network-secret` 的节点才能连接

### 为什么只支持 WSS/WS？

Cloudflare Workers 的网络模型只支持 HTTP/WebSocket 入站流量，不支持裸 TCP/UDP 端口监听。EasyTier 原生支持 `ws://` 和 `wss://` 隧道协议，因此 WSS 是最自然的连接方式。

| 协议 | CF Worker 支持 | 说明 |
|------|---------------|------|
| `wss://` (443) | ✅ | **推荐**，加密，默认端口 |
| `ws://` (80) | ✅ | 明文，CF 边缘仍处理 |
| `tcp://` | ❌ | Worker 无法监听裸 TCP |
| `udp://` | ❌ | Worker 不支持 UDP |

## 快速部署

### 前置条件

- [Node.js](https://nodejs.org/) 18+
- Cloudflare 账号（免费版即可，免费版支持 Durable Objects）

### 步骤

1. **安装 Wrangler CLI**

```bash
npm install
```

2. **登录 Cloudflare**

```bash
npx wrangler login
```

3. **部署**

```bash
npx wrangler deploy
```

部署成功后会输出 Worker 地址，例如：
```
https://cf-easytier-relay.<your-subdomain>.workers.dev
```

4. **配置环境变量**

在 Cloudflare Dashboard 中配置网络名称和密钥：

```
Workers & Pages -> cf-easytier-relay -> Settings -> Variables
```

添加以下变量（建议勾选 **Encrypt** 加密）：

| 变量名 | 说明 | 示例 |
|--------|------|------|
| `DEFAULT_NETWORK_NAME` | EasyTier 网络名称 | `my-private-network` |
| `DEFAULT_NETWORK_SECRET` | EasyTier 网络密钥 | `my-strong-secret-123` |

> ⚠️ 如果不配置这两个变量，所有连接都会被拒绝。配置后 Worker 会自动生效，无需重新部署。

可选环境变量（有默认值，可在 Dashboard 中按需覆盖）：

| 变量名 | 默认值 | 说明 |
|--------|--------|------|
| `MAX_CONNECTIONS_PER_INSTANCE` | `128` | 单个 DO 实例最大 WebSocket 连接数 |
| `IDLE_TIMEOUT_SECONDS` | `300` | WebSocket 空闲超时（秒） |
| `DEBUG_LOG` | `false` | 是否开启详细日志 |

## 客户端连接

### 方式一：URL 查询参数（推荐）

```bash
# Linux / macOS
sudo easytier-core -d \
  --network-name my-private-network \
  --network-secret my-strong-secret-123 \
  -p "wss://cf-easytier-relay.<your-subdomain>.workers.dev/?name=my-private-network&secret=my-strong-secret-123"

# Windows (PowerShell 管理员)
.\easytier-core.exe -d `
  --network-name my-private-network `
  --network-secret my-strong-secret-123 `
  -p "wss://cf-easytier-relay.<your-subdomain>.workers.dev/?name=my-private-network&secret=my-strong-secret-123"
```

### 方式二：自定义 Header

部分场景下可能不希望在 URL 中暴露密钥，可使用自定义 Header。但 EasyTier 原生 `-p` 参数不支持自定义 Header，此方式适用于通过代理或脚本注入 Header 的场景。

### 连接多个中继

为提高可用性，可同时连接多个共享节点：

```bash
sudo easytier-core -d \
  --network-name my-private-network \
  --network-secret my-strong-secret-123 \
  -p "wss://cf-easytier-relay.<your-subdomain>.workers.dev/?name=my-private-network&secret=my-strong-secret-123" \
  -p tcp://<其他公共节点IP>:11010
```

### 使用 WS 明文连接

如果不需要 TLS 加密（例如测试环境）：

```bash
sudo easytier-core -d \
  --network-name my-private-network \
  --network-secret my-strong-secret-123 \
  -p "ws://cf-easytier-relay.<your-subdomain>.workers.dev/?name=my-private-network&secret=my-strong-secret-123"
```

## 验证连接

部署并连接节点后，在任一节点上执行：

```bash
# 查看对等节点
easytier-cli peer

# 查看路由
easytier-cli route

# 测试连通性
ping <对端虚拟IP>
```

`easytier-cli peer` 输出中，`tunnel_proto` 列应显示 `ws` 或 `wss`。

## 状态监控

访问以下端点查看中继状态：

```
https://cf-easytier-relay.<your-subdomain>.workers.dev/health
https://cf-easytier-relay.<your-subdomain>.workers.dev/status
```

## 限制与注意事项

- **Cloudflare 免费版限制**：单 Worker 每日 100,000 次请求；Durable Objects 每月 100,000 次请求 + 400,000 GB-秒。对于中继场景，免费版可支持小规模网络（几十个节点）。
- **WebSocket 连接时长**：CF 默认 WebSocket 超时约 100 秒空闲断开，EasyTier 会自动重连。
- **延迟**：CF 边缘节点全球分布，通常延迟低于 50ms，但中继会增加一跳延迟。节点间优先建立 P2P 直连，中继仅作为 fallback。
- **带宽**：CF Workers 不限制带宽，但免费版有 CPU 时间限制（10ms/请求，WebSocket 不计 CPU 时间）。
- **私有模式**：`--private-mode true` 在 EasyTier 端启用，确保只有相同网络名和密钥的节点可以连接和通过本节点中转。

## 本地开发

```bash
npm run dev
```

然后在另一个终端启动 EasyTier 连接到 `ws://localhost:8787/?name=...&secret=...`。

## 项目结构

```
cf-easytier-relay/
├── src/
│   ├── index.js      # Worker 入口：路由、鉴权、WebSocket 升级
│   └── relay.js      # Durable Object：WebSocket 中继核心
├── examples/
│   ├── config.toml          # EasyTier TOML 配置示例
│   └── easytier-relay.service  # systemd 服务示例
├── wrangler.toml     # Cloudflare Worker 配置
├── package.json
└── README.md
```

## 相关链接

- [EasyTier GitHub](https://github.com/EasyTier/Easytier)
- [EasyTier 官方文档](https://easytier.cn)
- [搭建共享节点](https://easytier.cn/guide/network/host-public-server)
- [Cloudflare Durable Objects](https://developers.cloudflare.com/durable-objects/)
- [Cloudflare Workers WebSocket](https://developers.cloudflare.com/workers/runtime-apis/websockets/)

## License

MIT
