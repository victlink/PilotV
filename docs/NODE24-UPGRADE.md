# Node 24 升级（NAS 部署机）

> 2026-11-15 在 fnOS NAS 上实测完成。本文记录**为什么**要升、**怎么**升、以及**怎么回滚**。

## 为什么

PilotV 的 Agent 网关在 Node 22.22.2 上有已知的 V8 崩溃问题：

```
[pilotdeck] WARN Node.js 22.22.2 is known to crash with V8 "Check failed: marking_done_"
under concurrent long-context turns; upgrade to Node.js 24 LTS. See docs/COMMANDER-LOOP.md §12.
```

启动日志里的这行警告就是它。仓库里的 `start-windows.ps1` 也把「Node 24 LTS」写成硬前置（Node 22.22.2 的 V8 cppgc 断言会让网关在长上下文并发时崩溃）。

**换 Node 主版本后，原生模块必须同步换成对应 ABI**，否则 `require` 会直接报
`was compiled against a different Node.js version`。ABI：Node 22 = 127，Node 24 = 137。

## 受影响的东西

| 组件 | 说明 |
|---|---|
| `better-sqlite3` | 认证库 `auth.db` 用的就是它，**必须重编/换预编译包** |
| `node-pty` | 终端功能；包内只有 darwin/win32 预编译，linux 必须源码编译 |
| `bcrypt` | 用 N-API 预编译（`prebuilds/linux-x64/*.node`），**跨 Node 版本通用，不用动** |

## 步骤

### 1. 装 Node 24

```bash
VER=v24.22.3
cd /tmp
curl -fsSLO "https://nodejs.org/dist/$VER/node-$VER-linux-x64.tar.xz"
curl -fsSLO "https://nodejs.org/dist/$VER/SHASUMS256.txt"
grep " node-$VER-linux-x64.tar.xz\$" SHASUMS256.txt | sha256sum -c -
sudo -n tar -xJf "node-$VER-linux-x64.tar.xz" -C /usr/local/lib
sudo -n ln -sfn "/usr/local/lib/node-$VER-linux-x64" /usr/local/lib/node24
/usr/local/lib/node24/bin/node -v        # v24.22.3
/usr/local/lib/node24/bin/node -p "process.versions.modules"   # 137
```

> 下载可能很慢（实测 NAS → nodejs.org 只有 ~30KB/s，一次 32MB 下了 25 分钟）。
> `curl -C -` 断点续传 + `--speed-limit/--speed-time` 卡死检测很重要；
> 旧版 curl 没有 `--speed-limit-time`，只有 `--speed-time`。

### 2. 重编原生模块（ABI 137）

```bash
UP=/vol3/1000/Work/00/PilotV/pilotdeck-mobile/upstream-official
export PATH=/usr/local/lib/node24/bin:$PATH
export npm_config_nodedir=/usr/local/lib/node24     # 用本地 headers，别再下 node-gyp 头文件

cd "$UP/node_modules/.pnpm/better-sqlite3@12.10.0/node_modules/better-sqlite3"
npm run install        # prebuild-install 会拉 node-v137-linux-x64 预编译包

cd "$UP/node_modules/.pnpm/node-pty@1.1.0/node_modules/node-pty"
npm run install        # 没有 linux 预编译，走 node-gyp 源码编译（需要 gcc/g++/make/python3）
```

自检（两个都要能在 node24 下加载）：

```bash
cd "$UP/node_modules/.pnpm/better-sqlite3@12.10.0/node_modules/better-sqlite3"
/usr/local/lib/node24/bin/node -e "const D=require('better-sqlite3');const db=new D(':memory:');db.exec('create table t(a)');console.log('OK')"
cd "$UP/node_modules/.pnpm/node-pty@1.1.0/node_modules/node-pty"
/usr/local/lib/node24/bin/node -e "const p=require('node-pty');console.log('OK')"
```

### 3. 改 systemd 单元

| 单元 | 改法 |
|---|---|
| `pilotv-gateway.service` | `ExecStart=/usr/bin/node ...` → `ExecStart=/usr/local/lib/node24/bin/node ...` |
| `artifacts-mcp.service` | 同上 |
| `pilotdeck.service` | 加一行 `Environment=PATH=/usr/local/lib/node24/bin:/usr/local/sbin:...`（该单元原来没有 PATH 行，靠 systemd 默认 PATH，所以必须显式加） |
| `pilotv-artifacts.service` | 用的是 `/usr/bin/python3`，不用改 |

改完 `sudo systemctl daemon-reload`，再重启这三个单元。

### 4. 验证

```bash
# 进程真的跑在 node24 上
for p in $(sudo ss -ltnp | grep -oE 'pid=[0-9]+' | cut -d= -f2 | sort -u); do readlink /proc/$p/exe; done
# 启动日志里不该再有 Node 22 警告
tail -200 /home/Marc/.pilotdeck/pilotdeck-systemd.log | grep -c "Node.js 22.22.2 is known to crash"
# 链路健康
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3001/api/user/runtime-status   # 401 = 活着要鉴权
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:5187/                          # 200
```

## 回滚

- 单元：备份文件留在 `/etc/systemd/system/<unit>.service.bak-<时间戳>`，改回后 `daemon-reload` + 重启即可。
- 原生模块：备份留在 `/tmp/native-backup-<时间戳>/`（含 ABI 127 的 `better_sqlite3.node`、`pty.node`）。
- Node 本体：删掉 `/usr/local/lib/node24` 与解包目录即可，系统 `/usr/bin/node` 未被动过。

## 注意事项

- **别用 `git checkout` 换 Node 版本**：那会把 `node_modules` 里的原生模块一起换掉，得重编。
- 改单元时**先停 `pilotv-watchdog.timer`**：后端重启要 30~60 秒才就绪，看门狗会在这段时间里误判「不健康」并连续重启，制造风暴。
- 启动竞态：web（3001）可能比 agent（18789）先起来，桥接层第一次连接会超时并报
  `[pilotdeck-bridge] gateway connect failed after 60000ms`，随后自动重连成功（`connected → ws://127.0.0.1:18789/ws`），属于可恢复的启动噪声。
