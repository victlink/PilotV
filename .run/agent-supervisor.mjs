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
// a watcher: if 18789 goes down it starts a new detached gateway.
//
// Single-instance: a tiny TCP server on 18790 acts as a lock. A second
// supervisor stays alive in standby and takes over if the first one dies,
// which also stops the plugin host from respawning in a tight loop.

import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const RUN_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(RUN_DIR, '..');
const UPSTREAM = path.join(ROOT, 'pilotdeck-mobile', 'upstream-official');
const SUPERVISOR_LOG = path.join(RUN_DIR, 'supervisor.log');
const GATEWAY_LOG = path.join(RUN_DIR, 'agent.log');
const GATEWAY_PORT = 18789;
const LOCK_PORT = 18790;
const CHECK_MS = 3000;
const MAX_LOG_BYTES = 8 * 1024 * 1024;

let gateway = null;
let lockServer = null;
let active = false;
let spawning = false;
let stopping = false;

function log(message) {
  const line = `[${new Date().toISOString()}] ${message}\n`;
  try {
    try {
      if (fs.statSync(SUPERVISOR_LOG).size > MAX_LOG_BYTES) {
        const prev = SUPERVISOR_LOG.replace(/\.log$/, '.prev.log');
        try { fs.unlinkSync(prev); } catch { /* no previous log */ }
        fs.renameSync(SUPERVISOR_LOG, prev);
      }
    } catch { /* log does not exist yet */ }
    fs.appendFileSync(SUPERVISOR_LOG, line);
  } catch { /* never let logging kill the supervisor */ }
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

async function ensureGateway() {
  if (!active || stopping || spawning) return;
  if (gateway && gateway.exitCode === null) return;
  // A gateway we did not start (manual run, old instance) owns the port:
  // watch it instead of fighting for the same port.
  if (await portUp(GATEWAY_PORT)) return;

  spawning = true;
  try {
    let fd;
    try { fd = fs.openSync(GATEWAY_LOG, 'a'); } catch { fd = 'ignore'; }
    log(`port ${GATEWAY_PORT} is down; spawning detached gateway`);
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
    log(`gateway spawned pid=${pid} detached=true (survives this supervisor)`);
    gateway.once('exit', (code, signal) => {
      log(`gateway pid=${pid} exited code=${code} signal=${signal}`);
      if (gateway && gateway.pid === pid) gateway = null;
    });
    gateway.once('error', (err) => {
      log(`gateway pid=${pid} spawn error: ${err.message}`);
      if (gateway && gateway.pid === pid) gateway = null;
    });
  } catch (err) {
    log(`failed to spawn gateway: ${err.message}`);
    gateway = null;
  } finally {
    spawning = false;
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

log('=== detached supervisor starting ===');
const timer = setInterval(() => {
  if (active) ensureGateway();
  else acquireLock();
}, CHECK_MS);
acquireLock();
