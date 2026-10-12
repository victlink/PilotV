# PilotDeck Mobile

独立 React / TypeScript / Vite PWA 与 Node TypeScript MCP 中继项目。不修改原生 PilotDeck。当前为持续开发版本，**不是全功能等价交付**，详细状态见 [ACCEPTANCE.md](ACCEPTANCE.md)。

## 前端
```bash
npm ci
npm run dev
npm test
npm run build
```
生产文件位于 dist/。部署于 HTTPS 静态站点；手机访问开发服务使用开发机局域网地址，但远程 PWA 安装与 service worker 需要安全上下文。

## MCP 中继
```bash
cd gateway
npm ci
npm test
npm run build
```
配置与启动参数见 [gateway/README.md](gateway/README.md) 及 gateway/.env.example。配置固定上游白名单，不建立任意目标开放代理。中继仅进程内保留会话映射、不保存业务数据和密钥。/health 仅说明进程健康，不证明上游连通。必须部署于有鉴权的同源 HTTPS 反向代理后，SSE 关闭缓冲。

## 实例配置
通过侧栏添加名称、REST 地址、WS 地址、MCP 地址、令牌、备注。JSON 导入支持单对象或数组，字段为 name/rest/ws/mcp/notes，所有条目验证通过才保存，不导入令牌。默认令牌只在页面内存；主动勾选记住会明文保存在本机 localStorage，不推荐共享设备使用。

原生 Gateway 1.1 WS 与官方 UI REST 是不同服务和鉴权：
- 原生 WS 使用 hello 协议及 gateway token，不可填官方 UI 的聊天 WS 地址。
- 在原生模块切换“官方 UI REST”后，填 UI server 的地址和独立 UI JWT；如安装还要求 x-api-key，独立填写。这些凭证仅面板内存保存，切换面板需重新填写。
- MCP 标签使用官方 TypeScript SDK 的 Streamable HTTP 连接，可填中继 /mcp/:instanceId 地址或允许跨域的真实端点。当前共用实例 token 输入，请确保目标端点使用匹配凭证；不匹配时不要复用密钥。
- HTTPS 页面应使用 WSS；跨域请求受 CORS 限制，推荐同源代理。不得混用三种服务的接口或令牌。

## 已接入
项目与会话、原始聊天事件流；八类原生功能页；独立 UI REST 高级 JSON 参数面板；MCP 工具/资源/提示词。接口以当前源码核查为依据，能力不足明确显示不可用。高级 JSON 面板不等于官方 PC 完整交互复刻。

测试证据位于 tests/、gateway/test/ 和 review/。浏览器脚本 scripts/browser-smoke.mjs 依赖当前验证环境已有浏览器，不是跨机器即装即用的测试环境。生产发布前必须完成真实双后端、实机 PWA、安全和长期稳定性验收。
