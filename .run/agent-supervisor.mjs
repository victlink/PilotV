// PilotV agent gateway supervisor (detached mode).
//
// Why this exists:
//   The old .cmd supervisor ran the gateway in the FOREGROUND of a cmd.exe
//   console. When that console was recycled (plugin reload, logon-script exit,
//   task-scheduler cleanup) Windows sent CTRL_CLOSE and node exited gracefully
//   with NO stack trace - only `[telemetry] shutdown snapshot` in agent.log.
//   The Web bridge then lost its WebSocket and replied
//   "PilotDeck gateway is unavailable."
//
// Here the gateway is spawned with detached:true + windowsHide + unref, so it
// owns its own process group and outlives this supervisor, its cmd wrapper,
// the keeper plugin and even the 3001 Web/API process. This supervisor is only
// a watcher: if the gateway goes unhealthy it starts a new detached gateway.
//
// Single-instance: a tiny TCP server on 18790 acts as a lock. A second
// supervisor stays alive in standby and takes over if the first one dies,
// which also stops the plugin host from respawning in a tight loop.
//
// 2026-11-07 (plan P1.2) - two things were wrong with the "just restart it"
// model and both are fixed here:
//   1. CHECK_MS was a flat 3000ms. A chronic failure (bad config, port taken)
//      meant roughly 28k spawn attempts a day, refilling agent.log forever,
//      which looks like self-healing but never heals. Restarts now back off
//      3s -> 30s (service/supervisorPolicy.mjs) and alert once they stop being
//      plausible as a one-off crash.
//   2. "Port answers" was the only health signal. That is exactly the failure
//      we spent four rounds chasing: the process was alive, the port answered,
//      and every session was failing. We now read GET /healthz, which answers
//      "is this process still doing work" (ws count, degraded sessions,
//      compaction success rate), and only restart when it says the process is
//      actually stuck.

import net from 'node:net';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { backoffDelay, createRestartTracker, decideGatewayAction, judgeHealth } from '../service/supervisorPolicy.mjs';
import { rotateFile } from '../service/logRotation.mjs';

const RUN_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(RUN_DIR, '..');
const UPSTREAM = path.join(ROOT, 'pilotdeck-mobile', 'upstream-official');
// 路径可覆盖：测试要把日志指向临时目录，否则用例会去轮转开发机上正在写的
// .run/agent.log —— 那不是「测试通过」，那是测试顺手改了生产状态。
const SUPERVISOR_LOG = process.env.PILOTDECK_SUPERVISOR_LOG || path.join(RUN_DIR, 'supervisor.log');
const GATEWAY_LOG = process.env.PILOTDECK_GATEWAY_LOG || path.join(RUN_DIR, 'agent.log');
const GATEWAY_PORT = Number(process.env.PILOTDECK_AGENT_PORT || 18789);
// 和 GATEWAY_PORT 一样可覆盖：测试要用另一个端口起一份锁，
// 否则会把开发机上正在跑的那个 supervisor 的锁抢掉（这是真的会踩的坑）。
const LOCK_PORT = Number(process.env.PILOTDECK_AGENT_LOCK_PORT || 18790);
const CHECK_MS = 3000;
/** 探活本身的超时。比 CHECK_MS 短，否则一次探活就能把整个循环卡住。 */
const HEALTH_PROBE_TIMEOUT_MS = 2000;
/** healthz 里 at 字段允许的陈旧时间。网关自己每轮都会刷新它。 */
const HEALTH_STALE_MS = 60000;

let gateway = null;
let lockServer = null;
let active = false;
let spawning = false;
let stopping = false;
/** 下一次允许 spawn 的时间戳。退避靠它落地，不靠 setTimeout（避免被 sleep 打断后错乱）。 */
let nextSpawnAt = 0;

const tracker = createRestartTracker({
  // 告警走 supervisor.log；接通知系统时只需要换掉这一个回调。
  onAlert: undefined,
});

/** 最近一次成功读到的 healthz，用于「网关连不上」和「网关说不健康」区分记账。 */
let lastHealth = null;

function log(message) {
  const line = `[${new Date().toISOString()}] ${message}\n`;
  try {
    rotateSupervisorLog();
    fs.appendFileSync(SUPERVISOR_LOG, line);
  } catch { /* never let logging kill the supervisor */ }
}

function rotateSupervisorLog() {
  // 轮转失败绝不能杀守护进程，rotateFile 内部已经不抛；这里再包一层是防
  // statSync/renameSync 之外的意外（比如磁盘被拔掉）。
  try { rotateFile(SUPERVISOR_LOG); } catch { /* ignore */ }
}

function rotateGatewayLog() {
  try { rotateFile(GATEWAY_LOG); } catch { /* ignore */ }
}

function portUp(port) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port });
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      sock.destroy();
      resolve(value);
    };
    sock.setTimeout(1200);
    sock.once('connect', () => finish(true));
    sock.once('error', () => finish(false));
    sock.once('timeout', () => finish(false));
  });
}

/**
 * 读网关的 /healthz。拿不到就返回 null —— 调用方必须能区分
 * 「探测失败」和「网关报告不健康」，两者的处置方式不一样。
 */
function fetchHealth() {
  return new Promise((resolve) => {
    const request = http.get(
      { host: '127.0.0.1', port: GATEWAY_PORT, path: '/healthz', timeout: HEALTH_PROBE_TIMEOUT_MS },
      (response) => {
        let text = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => { text += chunk; });
        response.on('end', () => {
          if (response.statusCode !== 200) { resolve(null); return; }
          try { resolve(JSON.parse(text)); } catch { resolve(null); }
        });
      },
    );
    request.on('timeout', () => { request.destroy(); resolve(null); });
    // 探测失败是常态（网关正在启动、刚被杀），安静返回 null。
    request.on('error', () => resolve(null));
  });
}

/**
 * 一轮巡检：读状态 -> 交给决策表 -> 执行。
 *
 * 判读全部在 decideGatewayAction 里（service/supervisorPolicy.mjs），这里只负责
 * 取数和动手。之前判断和取数混在一起，「端口能连」被顺手当成「健康」，
 * 结果就是当年那种「进程在、端口通、每个会话都在失败」要人肉查四轮。
 */
async function ensureGateway() {
  if (!active || stopping || spawning) return;

  // 每轮巡检都先做一次体积检查。原来只在 spawn 前轮转，可网关是持续往
  // agent.log 追加的：它不重启，日志就永远没有轮转的机会 —— 1.82 GB 那次
  // 恰恰就是「进程一直活着」。一次 statSync 换掉「磁盘被写满」这一整类事故。
  rotateGatewayLog();

  const ownsProcess = Boolean(gateway && gateway.exitCode === null);
  const open = await portUp(GATEWAY_PORT);
  const health = open ? await fetchHealth() : null;
  if (health) lastHealth = health;

  const decision = decideGatewayAction({
    ownsProcess,
    portUp: open,
    health,
    nowMs: Date.now(),
    nextSpawnAt,
    staleMs: HEALTH_STALE_MS,
  });

  switch (decision.action) {
    case 'keep': {
      // 网关自称健康 = 之前那几次重启确实翻篇了，清账。
      if (decision.reason === 'healthy' && tracker.snapshot().restarts > 0) tracker.markHealthy();
      return;
    }
    case 'watch': {
      // 端口被别人占着（手工调试 / 老实例），看住不动手。
      return;
    }
    case 'backoff': {
      // 静默等待。这一条是防刷屏的关键：慢性病不再变成每天 2.8 万次 spawn。
      return;
    }
    case 'restart': {
      const pid = gateway && gateway.pid ? gateway.pid : '?';
      log('gateway pid=' + pid + ' -> restart (' + decision.reason
        + ', degraded=' + (decision.degraded ?? 0) + '/' + (health ? health.sessions : '?') + ')');
      const outcome = tracker.recordFailure();
      if (outcome.shouldAlert) log('ALERT ' + outcome.message);
      stopOurGateway(gateway);
      gateway = null;
      nextSpawnAt = Date.now() + backoffDelay(outcome.attempt);
      log('next restart not before ' + new Date(nextSpawnAt).toISOString() + ' (backoff)');
      return;
    }
    case 'spawn': {
      await spawnGateway(decision.reason);
      return;
    }
    default:
      log('unhandled supervisor decision: ' + decision.action);
  }
}

async function spawnGateway(reason) {
  spawning = true;
  try {
    rotateGatewayLog();
    let fd;
    try { fd = fs.openSync(GATEWAY_LOG, 'a'); } catch { fd = 'ignore'; }
    const attempt = tracker.snapshot().restarts + 1;
    log('port ' + GATEWAY_PORT + ' is down (' + reason + '); spawning detached gateway (attempt ' + attempt + ')');
    gateway = spawn(
      process.execPath,
      ['--import', 'tsx', 'src/cli/pilotdeck.ts', 'server', '--port', String(GATEWAY_PORT)],
      {
        cwd: UPSTREAM,
        env: process.env,
        detached: true,
        windowsHide: true,
        stdio: ['ignore', fd, fd],
      },
    );
    gateway.unref();
    if (typeof fd === 'number') { try { fs.closeSync(fd); } catch { /* already closed */ } }

    const pid = gateway.pid;
    tracker.recordStart();
    log('gateway spawned pid=' + pid + ' detached=true (survives this supervisor)');
    const onDown = (detail) => {
      log(detail);
      const outcome = tracker.recordFailure();
      if (outcome.shouldAlert) log('ALERT ' + outcome.message);
      nextSpawnAt = Date.now() + backoffDelay(outcome.attempt);
    };
    gateway.once('exit', (code, signal) => {
      if (gateway && gateway.pid === pid) gateway = null;
      onDown('gateway pid=' + pid + ' exited code=' + code + ' signal=' + signal);
    });
    gateway.once('error', (err) => {
      if (gateway && gateway.pid === pid) gateway = null;
      onDown('gateway pid=' + pid + ' spawn error: ' + err.message);
    });
  } catch (err) {
    log('failed to spawn gateway: ' + err.message);
    gateway = null;
    const outcome = tracker.recordFailure();
    nextSpawnAt = Date.now() + backoffDelay(outcome.attempt);
  } finally {
    spawning = false;
  }
}
/**
 * 让我们自己起的那个网关退出，但不碰不是我们起的进程。
 *
 * Windows 上 process.kill(pid) 是 TerminateProcess，没有退出清理；对 detached
 * 子进程发 SIGTERM 语义有限。这里只做「礼貌地请它下来」，失败也不报错：
 * 真正的判据是 18789 端口空出来，端口没空就会继续退避重试。
 */
function stopOurGateway(child) {
  if (!child || !child.pid) return;
  try {
    process.kill(child.pid);
    log(`asked gateway pid=${child.pid} to exit (unhealthy)`);
  } catch (error) {
    log(`could not signal gateway pid=${child.pid}: ${error.code || error.message}`);
  }
}

function acquireLock() {
  if (active || stopping || lockServer) return;
  const server = net.createServer((socket) => {
    // A health probe or port scanner often connects to 18790 and closes before
    // reading the reply. That surfaces as ECONNRESET on the socket; with no
    // 'error' listener it is an unhandled event and kills the whole supervisor.
    // The keeper then restarts it, over and over. Swallow expected resets and
    // only log anything else.
    socket.on('error', (err) => {
      if (err?.code && err.code !== 'ECONNRESET') {
        log(`lock socket error: ${err.code} ${err.message}`);
      }
    });
    socket.end(JSON.stringify({
      ok: true,
      supervisorPid: process.pid,
      gatewayPid: gateway ? gateway.pid : null,
      gatewayPort: GATEWAY_PORT,
      detached: true,
      // doctor/运维能一眼看到「重启了几次、现在还处不处在退避里」。
      restarts: tracker.snapshot().restarts,
      backingOff: Date.now() < nextSpawnAt,
      lastHealth: lastHealth
        ? {
          status: lastHealth.status,
          sessions: lastHealth.sessions,
          degradedSessions: lastHealth.degradedSessions,
          compaction: lastHealth.compaction,
        }
        : null,
    }) + '\n');
  });
  server.on('error', (err) => {
    lockServer = null;
    if (err.code === 'EADDRINUSE') {
      log('another supervisor owns the lock; standby (will retry)');
    } else {
      log(`lock server error: ${err.message}`);
    }
  });
  server.listen(LOCK_PORT, '127.0.0.1', () => {
    lockServer = server;
    active = true;
    log(`lock acquired on 127.0.0.1:${LOCK_PORT}, supervisor pid=${process.pid}`);
    ensureGateway();
  });
}

function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  log(`received ${signal}; exiting WITHOUT killing detached gateway pid=${gateway ? gateway.pid : null}`);
  clearInterval(timer);
  if (lockServer) { try { lockServer.close(); } catch { /* ignore */ } }
  setTimeout(() => process.exit(0), 200).unref();
}

if (!fs.existsSync(path.join(UPSTREAM, 'src', 'cli', 'pilotdeck.ts'))) {
  log(`FATAL: gateway entry not found under ${UPSTREAM}`);
  process.exit(1);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGHUP', () => shutdown('SIGHUP'));

/** 只在「被直接执行」时进入守护循环；被 import 时保持完全安静。 */
const isMain = process.argv[1]
  && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isMain) {
  log('=== detached supervisor starting (backoff + healthz) ===');
  const timer = setInterval(() => {
    if (active) ensureGateway();
    else acquireLock();
  }, CHECK_MS);
  acquireLock();
}

// 导出给测试用。这些是纯状态/纯判定，import 本身不会产生任何副作用。
export const __testables = {
  acquireLock,
  ensureGateway,
  fetchHealth,
  judgeHealth,
  portUp,
  rotateGatewayLog,
  rotateSupervisorLog,
  setGateway: (value) => { gateway = value; },
  setActive: (value) => { active = value; },
  /** 测试收尾用：放掉锁并停止巡检，但不要把宿主进程也退出。 */
  releaseLock: () => {
    if (lockServer) {
      try { if (typeof lockServer.closeAllConnections === 'function') lockServer.closeAllConnections(); } catch { /* ignore */ }
      try { lockServer.close(); } catch { /* ignore */ }
      lockServer = null;
    }
    active = false;
  },
  setNextSpawnAt: (value) => { nextSpawnAt = value; },
  tracker,
  paths: { SUPERVISOR_LOG, GATEWAY_LOG, GATEWAY_PORT, LOCK_PORT },
};