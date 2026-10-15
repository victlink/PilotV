# 资料页（WeKnora）接入与运维

「探索 → 资料」这一页是整块 iframe 打开本机的 [WeKnora](https://github.com/Tencent/WeKnora)（企业级 RAG / 知识库）。
WeKnora 不在 PilotV 仓库里，单独装在相邻目录，用一个 nginx 侧车对外提供入口。

## 装在哪

```
/vol3/1000/Work/00/
├── PilotV/                  前端 + 网关 + 成果台（本仓库）
└── WeKnora/                 WeKnora 源码 + 容器（独立仓库）
    ├── .env                 密钥都在这，不要提交、不要外发
    ├── docker-compose.yml   上游自带
    └── pilotv/              本次接入新增的三个文件
        ├── setup_env.py            从 .env.example 生成 .env
        ├── docker-compose.pilotv.yml  端口改写
        └── weknora-frame-proxy.conf   对外的 nginx 侧车
```

## 端口

| 端口 | 谁在用 | 绑定 | 说明 |
| --- | --- | --- | --- |
| 8080 | `WeKnora-frame-proxy` | `0.0.0.0` | **唯一对外入口**，页面和 `/api/*` 都从这里出去 |
| 18081 | `WeKnora-frontend` | `127.0.0.1` | 侧车背后的上游，不该被外面直接访问 |
| 18080 | `WeKnora-app` | `127.0.0.1` | 后端 API，同样只在回环 |
| — | postgres / redis | Compose 内网 | 不映射宿主机端口，避免和本机已有服务撞 |

上游 compose 默认要占 80 / 5432 / 6379，本机这些端口已经有别的服务了，所以
`pilotv/docker-compose.pilotv.yml` 用 `!override` 整段改掉了 `ports`，并显式把 8080
绑到 `0.0.0.0`——PilotV 前端跑在另一台机器的浏览器里，必须能从网络访问。

### 为什么是侧车，不是 `/weknora/*` 反代

WeKnora 的前端是 Vite 打包的，静态资源引用根路径 `/assets/*`。挂成
`PilotV/weknora/*` 子路径会和 PilotV 自己的 `/assets/*` 撞掉。要走子路径就得给
WeKnora 重新打一次 base，属实不值当。于是侧车直接吃掉一个 origin：去掉
`X-Frame-Options`、补上 `Content-Security-Policy: frame-ancestors *`，并放行
SSE / WebSocket / 上传，其它一律透传。

## 启停

```bash
cd /vol3/1000/Work/00/WeKnora
C="docker compose -f docker-compose.yml -f pilotv/docker-compose.pilotv.yml"

$C up -d      # 起（第一次会拉约 5GB 镜像，耐心等）
$C ps         # 看状态：app / postgres / docreader 应该都是 healthy
$C down       # 停（保留数据卷）
$C logs -f frame-proxy
```

两个 `-f` 都要给。少一个就等于退回上游默认端口，会去抢 80/5432/6379。

### 健康检查

```bash
curl -s http://127.0.0.1:8080/__pilotv_health     # {"ok":true,"service":"weknora"}
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8080/   # 200
```

`/__pilotv_health` 是侧车自己加的一个 `location`，只返回一行 JSON 并带上
`Access-Control-Allow-Origin: *`。页面靠它判断「WeKnora 起了没有」——直接挂
iframe 的话，WeKnora 停了用户只会看见浏览器的报错页，根本不知道该去看 Docker。

## 前端怎么知道 WeKnora 在哪

网关在返回首页 HTML 时注入 `window.__PILOTV__.weknoraUrl`：

- 默认取**当前访问 PilotV 的主机名** + `PILOTV_WEKNORA_PORT`（8080）。
  所以 `http://100.90.196.104:5186/` 打开的页面会去开
  `http://100.90.196.104:8080/`，换机器部署不用改代码、不用重新构建前端。
- `PILOTV_WEKNORA_URL` 可以直接钉死地址，优先级最高。
- 端口取不到、Host 头不合法时注入 `null`，前端退回「同主机 + 8080」。

## 首次使用

WeKnora 是自带账号体系的，**第一次用要在嵌进去的登录页里点「创建账户」**注册，
然后才能建知识库。注册完 PilotV 不用再登一次——会话是 WeKnora 自己种的。

问答功能还要在 WeKnora 里配模型 / API Key（DeepSeek、混元、OpenAI 兼容都行），
没配之前界面能用但检索问答不出结果。

## HTTPS 是另一回事

WeKnora 侧车现在只提供纯 HTTP。**从 HTTPS 入口访问 PilotV 时，浏览器会把页面里
的 `http://…:8080` iframe 当混合内容拦掉**，资料页会一直是空白。

要支持 HTTPS 就得单独给 WeKnora 配一份 TLS 反代（certbot 或内网证书都行），
然后把地址告诉 PilotV：

```bash
export PILOTV_WEKNORA_URL=https://weknora.example.lan
```

注意别直接改 WeKnora 侧车的 nginx.conf 里的 `listen 8080`，那是在容器内；
证书要挂进容器或换一个新的 TLS 侧车。

## 更新 WeKnora

```bash
cd /vol3/1000/Work/00/WeKnora
git pull
docker compose -f docker-compose.yml -f pilotv/docker-compose.pilotv.yml pull
docker compose -f docker-compose.yml -f pilotv/docker-compose.pilotv.yml up -d
```

**别重新跑 `pilotv/setup_env.py`。** `.env` 里的 `JWT_SECRET`、`SYSTEM_AES_KEY`、
`SYSTEM_SIGNING_KEY` 是现有数据（账号、已建知识库）的解密依据，重新生成等于
把这些数据变成读不出来的乱码。脚本只在第一次装的时候跑；上游 `.env.example`
有新增字段时，手工补进去。

## 自动化验收

```bash
cd /vol3/1000/Work/00/PilotV
node pilotdeck-mobile/scripts/weknora-e2e-check.mjs
# 换入口：PILOTV_URL=http://100.90.196.104:5186/ node pilotdeck-mobile/scripts/weknora-e2e-check.mjs
```

脚本用 Playwright 走完整链路：PilotV 首页 → 切到真实项目（`general` 项目里
「探索」整个不渲染）→ 探索 → 资料 → 读 iframe 里的真实页面文本，并把截图写到
`pilotdeck-mobile/scripts/weknora-e2e-shots/`。有 FAIL 时以非零码退出。

它依赖 `/home/Marc/PilotDeck-src/node_modules` 里的 playwright，这是本机路径，
换机器要改成自己的依赖。