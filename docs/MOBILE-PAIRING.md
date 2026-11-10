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

## 不依赖 Tailscale：公网隧道 + 多入口

扫码之后手机要连的是「二维码里写的那个地址」。默认只有局域网 IP / Tailscale 名，
手机一出门就连不上。解决办法不是打洞，而是**让宿主主动出站建一条反 tunnel**，
手机走公网域名进来 —— 不需要公网 IP、不需要路由器端口映射、不需要装任何 VPN。

### 1. 建一条独立的 Cloudflare 隧道

不要和别人共用的隧道混在一起：改配置要重启进程，会顺带断掉别人的入口。

```bash
cloudflared tunnel create pilotv
cloudflared tunnel route dns pilotv pilotv.example.com
```

`~/.cloudflared/pilotv-config.yml`：

```yaml
tunnel: <tunnel-uuid>
credentials-file: /home/<user>/.cloudflared/<tunnel-uuid>.json
no-autoupdate: true
ingress:
  - hostname: pilotv.example.com
    service: http://127.0.0.1:5187      # 直接接网关，不要绕 Caddy
    originRequest:
      # 必须覆盖：网关的同源校验是 new URL(origin).host === host，
      # 不覆盖的话 cloudflared 会传 127.0.0.1:5187，WebSocket 直接 403。
      httpHostHeader: pilotv.example.com
  - service: http_status:404
```

**为什么绕过 Caddy**：CF 边缘已经做了 TLS 终结，再用 Caddy 只是多一跳；
而且 Caddy 会为这个域名尝试一次 ACME 申请，而 HTTP-01 挑战被 Cloudflare 代理挡住，注定失败。

用 systemd user unit 常驻（`loginctl enable-linger <user>` 保证开机自动起）：

```ini
[Service]
ExecStart=/usr/bin/cloudflared tunnel --config %h/.cloudflared/pilotv-config.yml run
Restart=always
RestartSec=10
```

### 2. 告诉网关自己的公网入口

写在项目根的 `.env.local`（`start.sh` 会加载，不进版本库）：

```bash
PILOTV_PUBLIC_ORIGINS="${PILOTV_PUBLIC_ORIGINS:-https://pilotv.example.com}"
# 想同时带局域网入口（要求网关监听到局域网网卡上）：
# PILOTV_LAN_PORT="${PILOTV_LAN_PORT:-5187}"
```

重启网关后，二维码的 `a` 参数里就会多出这些地址。手机端按顺序试连：
**主入口（你打开 `/pair` 时用的那个）→ 备用入口**，第一个握上手的就用。

`a` 参数示例（`|` 分隔，最多两个，控制二维码尺寸）：

```
pilotv://pair?v=1&h=https://pilotv.example.com&a=http://192.168.1.24:5187&c=K7M2QP&s=…
```

### 3. 证书策略：公共 CA 与自签必须分开处理

| 入口类型 | 证书 | 客户端策略 |
|---|---|---|
| 公网隧道 / 有域名 | 公共 CA（Cloudflare、Let's Encrypt） | 走系统信任库 + 校验主机名，**不钉叶子指纹** |
| 局域网自签 | 自签 | 首次信任（TOFU）+ 钉住 SHA-256 指纹 |

不能把两者混成一套：Cloudflare 的边缘证书是池化、短周期轮换的，
如果钉住配对当天那张，**几天后必然全部连不上**，而现象看起来像网络故障。
同理反向：公共 CA 校验通过后如果不再校验主机名，任何持有合法证书的站点都能冒充你的域名。

### 4. 局域网入口需要网关监听非回环地址

默认 `PILOTV_BIND=127.0.0.1`，只有反向代理能访问。要让手机在同一个 Wi-Fi 下直连，
得把它改成 `0.0.0.0`（或具体网卡地址），并接受「同一局域网内能看到登录页」这个暴露面。
没有这个需求就保持默认，只用公网入口 —— 功能完整，只是同网时也要绕一圈 Cloudflare。

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
| 手机扫了没反应 | 手机要能访问二维码里的 origin；只配了局域网地址时出门就不可达，配 `PILOTV_PUBLIC_ORIGINS` 才有公网兜底 |
| 公网入口 WS 403 | cloudflared 没设 `httpHostHeader`，网关看到的 Host 是 `127.0.0.1:5187` |
| 以前能用、某天全 401 | 常见于钉了公共 CA 的叶子指纹而证书轮换了；客户端应只在自签场景固定指纹 |
| 兑换 409 `already_used` | 码被用过或页面自动刷新过；重新生成 |
| 兑换 429 `too_many_attempts` | 秘密输错 5 次；重新生成二维码 |
