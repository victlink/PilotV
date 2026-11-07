#!/usr/bin/env node
// gateway-keeper 的服务器端。由 ui/server(3001) 用 plugin-process-manager 拉起：
//   它 spawn `node <pluginDir>/server.mjs`，env 被裁剪成 PATH/HOME/NODE_ENV/PLUGIN_NAME，
//   并要求 10 秒内往 stdout 打印 {"ready":true,"port":N}。
//
// 职责只有一件：保证「有一个 supervisor 在看着 agent gateway」。判定全在
// keeper-core.mjs，重启退避与 /healthz 判读全在 agent-supervisor.mjs /
// supervisorPolicy.mjs。这里绝不再判一遍 gateway 健康 —— 两套口径一旦不一致，
// 现象是两个东西互相重启对方。
//
// 为什么直接 spawn node 而不是走 .run/agent-supervisor.cmd：
// 那个 .cmd 存在的唯一理由是在计划任务环境下找到 node.exe（它自己不是 node 起的）。
// keeper 本身就是被 node 拉起的，process.execPath 就是现成的答案，绕开 .cmd 也就
// 绕开了「.cmd 必须 CRLF + 纯 ASCII 否则 cmd.exe 偏移错乱」这一整类历史故障。
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  LOCK_PORT,
  classifyLockProbe,
  decideKeeperAction,
  defaultRepoCandidates,
  readyLine,
  resolveRepoRoot,
  mergeKeeperConfig,
  planKeeperStep,
  statusPayload,
} from './keeper-core.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PILOTV_KEEPER_PORT || 0); // 0 = 让系统分配，再报给宿主
const CHECK_MS = Number(process.env.PILOTV_KEEPER_INTERVAL_MS || 15000);
const ANCHOR = path.join('service', 'pilotv_gateway.mjs');
const USER_CONFIG_FILE = path.join(os.homedir() || process.env.USERPROFILE || '', '.pilotdeck', 'gateway-keeper.json');
// 插件目录内的配置优先于用户目录的。
// 宿主给插件的 env 被裁剪成 PATH/HOME/NODE_ENV/PLUGIN_NAME（plugin-process-manager.js），
// 环境变量路子在插件里基本无用；而插件目录是每个安装自己能控的唯一位置。
// 多机器上给某一台单独开 dryRun、或指定它看哪个仓库，都靠这个文件。
const LOCAL_CONFIG_FILE = path.join(HERE, 'keeper.json');

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function readConfig() {
  // 用户目录覆盖插件包内默认，方向见 mergeKeeperConfig。
  return mergeKeeperConfig({ userConfig: readJson(USER_CONFIG_FILE), localConfig: readJson(LOCAL_CONFIG_FILE) });
}

function locateRepo() {
  const config = readConfig();
  const exists = (dir) => {
    try {
      return fs.existsSync(path.join(dir, ANCHOR));
    } catch {
      return false;
    }
  };
  // probeInstallRoot 只能当候选，不能直接返回。
  // 它写在候选外面时犯过一个真错：插件还在仓库里被原地加载时，它会把用户
  // 显式写错的 repoRoot/env 直接覆盖掉。显式配置必须拥有否决权，否则「我明明
  // 指定了另一台机器」会被静静忽略，而 keeper 会在本机上起服务。
  return resolveRepoRoot({
    config,
    env: process.env,
    candidates: [probeInstallRoot(), ...defaultRepoCandidates({ homedir: os.homedir(), env: process.env })].filter(Boolean),
    anchorExists: exists,
  });
}

/**
 * 从插件自身的安装位置反推仓库根。
 * 只作为候选，仍然要过锚点校验：装在 ~/.pilotdeck/plugins 下时这里会算出一个
 * 无意义的目录，靠锚点把它筛掉，而不是让它冒充仓库。
 */
function probeInstallRoot() {
  let dir = HERE;
  for (let depth = 0; depth < 6; depth += 1) {
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
    if (fs.existsSync(path.join(dir, ANCHOR))) return dir;
  }
  return null;
}

function probeLock(timeoutMs = 2000) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port: LOCK_PORT });
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done({ connected: true }));
    socket.once('timeout', () => done({ errorCode: 'ETIMEDOUT' }));
    socket.once('error', (error) => done({ errorCode: error.code || 'ERROR' }));
  });
}

const state = {
  repoRoot: null,
  repoSource: 'none',
  lockReachable: undefined,
  action: null,
  why: null,
  spawnCount: 0,
  lastSpawnMs: null,
  lastError: null,
  child: null,
};

function spawnSupervisor(repoRoot) {
  const supervisor = path.join(repoRoot, '.run', 'agent-supervisor.mjs');
  if (!fs.existsSync(supervisor)) {
    state.lastError = `找不到 ${supervisor}`;
    return false;
  }
  // detached + unref：supervisor 死掉时 keeper 不该跟着被带走，反之也一样。
  // stdio 指向 supervisor 自己的日志文件，不能接 keeper 的 stdout ——
  // 宿主会把任何非 JSON 行当成启动协议噪音。
  const logFile = path.join(repoRoot, '.run', 'supervisor.log');
  try {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    const out = fs.openSync(logFile, 'a');
    const child = spawn(process.execPath, [supervisor], {
      cwd: path.join(repoRoot, '.run'),
      detached: true,
      windowsHide: true,
      stdio: ['ignore', out, out],
    });
    child.unref();
    // 句柄已经被子进程继承，这边必须关。
    // keeper 是长期跑的，每拉起一次漏一个 fd，几天就是几十个。
    fs.closeSync(out);
    child.on('error', (error) => {
      // 没有这个监听器，spawn 失败会作为未处理的 'error' 事件直接打死 keeper。
      // keeper 死了之后没人再看 supervisor，等于整条监督链没了，而且没有痕迹。
      state.lastError = `supervisor 进程出错：${error.code || error.message}`;
      state.child = null;
    });
    child.on('exit', (code, signal) => {
      // supervisor 退出不一定是故障（它自己也会被人停掉）；这里只清状态并记一笔，
      // keeper 下一轮靠锁探测重新判断，而不是盲目重启。
      state.lastError = code === 0 ? null : `supervisor 退出 code=${code} signal=${signal || '-'}`;
      state.child = null;
    });
    state.child = child;
    state.spawnCount += 1;
    state.lastSpawnMs = Date.now();
    state.lastError = null;
    return true;
  } catch (error) {
    state.lastError = String(error.message || error);
    return false;
  }
}

function configDryRun() {
  return readConfig().dryRun === true;
}

async function tick() {
  const located = locateRepo();
  state.repoRoot = located.root;
  state.repoSource = located.source;
  if (!located.root) {
    state.action = 'blocked';
    state.why = decideKeeperAction({ repoRoot: null }).why;
    return;
  }
  state.lockReachable = classifyLockProbe(await probeLock());
  const decision = decideKeeperAction({
    repoRoot: located.root,
    lockReachable: state.lockReachable,
    nowMs: Date.now(),
    lastSpawnMs: state.lastSpawnMs,
  });
  const plan = planKeeperStep(decision, { dryRun: configDryRun() });
  state.action = plan.action;
  state.why = plan.why;
  if (plan.executed) spawnSupervisor(located.root);
}

const server = http.createServer((req, res) => {
  const send = (code, payload) => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
  };
  if (!req.url || req.url === '/' || req.url.startsWith('/status')) {
    send(200, statusPayload({
      repoRoot: state.repoRoot,
      lockReachable: state.lockReachable,
      action: state.action,
      why: state.why,
      spawnCount: state.spawnCount,
      lastSpawnMs: state.lastSpawnMs,
      supervisorPid: state.child?.pid ?? null,
      repoSource: state.repoSource,
      lastError: state.lastError,
      dryRun: configDryRun(),
      checkIntervalMs: CHECK_MS,
    }));
    return;
  }
  if (req.url.startsWith('/check')) {
    // 手动催一次：给 pilotv doctor 和「我刚装了服务，现在就想确认」用。
    tick().then(
      () => send(200, { ok: true, action: state.action, why: state.why }),
      (error) => send(500, { ok: false, error: String(error.message || error) }),
    );
    return;
  }
  send(404, { error: 'not found' });
});

server.listen(PORT, '127.0.0.1', async () => {
  process.stdout.write(readyLine(server.address().port));
  await tick().catch(() => {});
  // 定时器不 ref：keeper 该在宿主结束它时干净退出，而不是自己赖着。
  const timer = setInterval(() => { tick().catch(() => {}); }, CHECK_MS);
  const stop = () => { clearInterval(timer); server.close(() => process.exit(0)); };
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, stop);
});

const isMain = process.argv[1]
  && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (!isMain) {
  // 被 import 时不发 ready 行、不起服务：测试只需要 keeper-core。
  server.close();
}