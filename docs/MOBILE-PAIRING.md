# 手机/平板配对（扫码连接）

> 状态：已实现（宿主端接口 + 网关 `/pair` 页面 + 单测）。客户端见
> `../PilotV-Android/`（交付工件，不在本仓库）。

## 为什么需要它

Web 端拿登录态的方式是「输账号密码换 JWT」（`POST /api/auth/login`，7 天）。
手机上重复这件事有三个问题：慢、输入法/截屏容易带走密码、以及自签证书下
PWA 连登录页都可能进不去。配对把「证明你就在这台机器跟前」换成一次扫码。

## 契约

```
pilotv://pair?v=1&h=<origin>&c=<6位码>&s=<secret>&n=<宿主名>&ttl=<秒>
```

| 端点 | 鉴权 | 请求 | 响应 |
|---|---|---|---|
| `POST /api/pilotv/pair/new` | 登录态 | `{origin?}` | `{code, secret, uri, expiresAt, ttlSeconds, qrPath}` |
| `GET /api/pilotv/pair/render.svg?d=<base64url(uri)>` | 登录态 | — | `image/svg+xml` |
| `GET /api/pilotv/pair/status?code=` | 登录态 | — | `{state: pending\|used\|expired\|unknown}` |
| `POST /api/pilotv/pair/redeem` | 凭 secret | `{code, secret, deviceName, platform, deviceId?}` | `{ok, token, device, origin, serverName}` |
| `GET /api/pilotv/pair/devices` | 登录态 | — | `{devices: [...]}` |
| `DELETE /api/pilotv/pair/devices/:id` | 登录态 | — | `{ok}` |

`origin` 必须与本次请求的 `x-forwarded-host`（或 `host`）一致；要放行别的入口，
配 `PILOTV_PAIR_ORIGINS`（逗号分隔的完整 origin）。

## 多设备部署：逐请求绑定设备

网关默认按 Cookie `pdv_backend` 选后端，手机没有 Cookie，会被转到 `defaultBackend`。
所以 `/pair` 页面由网关渲染时注入了当前设备源，`POST /new` 带上 `deviceOrigin` 并随
`/redeem` 下发。客户端之后必须：

- HTTP：`X-PilotV-Device: <deviceOrigin>`
- WebSocket：`/ws?token=…&d=<deviceOrigin>`

否则「在 B 机页面扫码、手机连到 A 机」，表现是莫名其妙的 401。

## 安全边界

- **5 分钟、一次性、试错 5 次**；秘密只以 sha256 落内存，日志与磁盘都没有明文。
- 兑换免登录，但必须同时给出 code + secret，等价于「看到了那台机器的屏幕」。
- 二维码由本机渲染（vendor `qrcode-generator`，MIT），**不调用任何第三方图片服务**——
  配对串里有秘密，不能塞进别人的 URL。
- 重启后未兑换的码全部作废（不落盘）；已配对设备台账在 `~/.pilotdeck/paired-devices.json`（0600）。
- **移除设备 ≠ 立刻吊销 token**：JWT 是无状态的。真要全量失效只能换
  `JWT_SECRET` 并重启。别把「移除」当安全事件用。

## 排障

| 现象 | 原因 |
|---|---|
| 页面 401 | 浏览器没登录；先开 `/` 登录再回 `/pair` |
| `bad_origin` | 用 IP 打开页面但反向代理改了 Host；显式配 `PILOTV_PAIR_ORIGINS` |
| 手机扫了没反应 | 手机要能访问二维码里的 origin（同 Wi-Fi / Tailscale）；先用手机关掉移动数据试 |
| 兑换 409 `already_used` | 码被用过或页面自动刷新过；重新生成 |
| 兑换 429 `too_many_attempts` | 秘密输错 5 次；重新生成二维码 |
