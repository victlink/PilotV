#!/usr/bin/env node

import { existsSync, unlinkSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { computerUseMcpConfigPath } from './services/computerUsePaths.js';
import { fileURLToPath } from 'node:url';
import {
  getRestartRequestFile,
  RESTART_EXIT_CODE,
} from './services/updateRuntime.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const UI_ROOT = path.resolve(__dirname, '..');

// 就绪判定失败不会直接判死：端口被上一个进程占着时，第一次必然超时，自动再起一次
// 通常就能拿到空闲端口，用户不必对着「正在启动 Gateway」等满 90 秒再手动点重启。
// 2026-11-13：主机在 tsx 冷启动 + 高负载下会超过 90s，被误判为「未就绪」而反复重启，
// 表现为页面间歇性 502。首启放宽到 120s、重试到 80s，减少这种误判重启。
const GATEWAY_READINESS_TIMEOUT_MS = 120_000;
// 重试那次进程已经预热（tsx 已缓存转译结果），不需要再给整份超时时间。
const GATEWAY_RETRY_TIMEOUT_MS = 80_000;
const GATEWAY_READINESS_MAX_ATTEMPTS = 2;
const GATEWAY_RETRY_DELAY_MS = 1_000;

export function normalizeSupervisorMode(value) {
  return value === 'dev' ? 'dev' : 'start-built';
}

export function resolveSupervisorConfigPath(value, baseCwd = process.cwd()) {
  const configuredPath = typeof value === 'string' ? value.trim() : '';
  return configuredPath ? path.resolve(baseCwd, configuredPath) : undefined;
}

export function getRuntimeCommands(mode, uiRoot = UI_ROOT, env = process.env) {
  const normalizedMode = normalizeSupervisorMode(mode);
  const repoRoot = path.resolve(uiRoot, '..');
  const sourceGateway = path.join(repoRoot, 'src', 'cli', 'pilotdeck.ts');
  const builtGateway = path.join(repoRoot, 'dist', 'src', 'cli', 'pilotdeck.js');
  const hasBuiltGateway = existsSync(builtGateway);
  const packagedRuntime = hasBuiltGateway && !existsSync(sourceGateway);
  // 2026-11-13：源码仓库里 .ts 一定存在，packagedRuntime 恒为 false，于是生产环境
  // 一直用 `--import tsx` 现场转译整个 src。tsx 冷启动既慢又吃 CPU，高负载下会被
  // 就绪检查判成失败并反复重启（历史上 25 次）。这里允许显式选择预编译产物：
  //   PILOTDECK_RUNTIME_MODE=built   → 网关走 dist/src/cli/pilotdeck.js（纯 JS，无需 tsx）
  //   PILOTDECK_RUNTIME_MODE=source  → 强制源码（默认行为不变）
  const runtimeMode = String(env.PILOTDECK_RUNTIME_MODE || '').toLowerCase();
  const useBuiltGateway = packagedRuntime || (runtimeMode === 'built' && hasBuiltGateway);
  const serverEntry = path.join(uiRoot, 'server', existsSync(path.join(uiRoot, 'server/supervisedBootstrap.js')) ? 'supervisedBootstrap.js' : 'index.js');
  const commands = [
    {
      name: 'server',
      command: process.execPath,
      // UI 服务端始终保留 tsx：ui/server 直接 import ../../src/*（含 .ts），
      // 没有对应的 dist 映射，去掉 tsx 会 ERR_UNKNOWN_FILE_EXTENSION。
      args: [...(packagedRuntime ? [] : ['--import', 'tsx']), serverEntry],
      cwd: uiRoot,
      ipc: true,
      critical: true,
    },
  ];
  if (normalizedMode === 'dev') {
    commands.push({
      name: 'client',
      command: process.execPath,
      args: [path.join(uiRoot, 'node_modules', 'vite', 'bin', 'vite.js')],
      cwd: uiRoot,
      ipc: false,
      critical: true,
    });
  }
  commands.push({
    name: 'gateway',
    command: process.execPath,
    args: useBuiltGateway ? [builtGateway, 'server'] : ['--import', 'tsx', sourceGateway, 'server'],
    cwd: repoRoot,
    ipc: true,
    critical: false,
  });
  return commands;
}

export function waitForPort(port, host = '127.0.0.1', timeoutMs = 90_000) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const socket = net.createConnection({ host, port });
      socket.once('connect', () => {
        socket.end();
        resolve();
      });
      socket.once('error', () => {
        socket.destroy();
        if (Date.now() - startedAt >= timeoutMs) {
          reject(new Error(`Timed out waiting for ${host}:${port}`));
          return;
        }
        setTimeout(attempt, 250);
      });
    };
    attempt();
  });
}

export function createRuntimeSupervisor({
  mode,
  env = process.env,
  spawnImpl = spawn,
  waitForPortImpl = waitForPort,
  exists = existsSync,
  unlink = unlinkSync,
  cwd = UI_ROOT,
  requestFile = getRestartRequestFile({ env: { ...env, PILOTDECK_RESTART_MODE: mode } }),
  platform = process.platform,
  log = console.log,
  error = console.error,
  exit = process.exit,
  processLike = process,
} = {}) {
  const normalizedMode = normalizeSupervisorMode(mode);
  const commandSpecs = getRuntimeCommands(normalizedMode, cwd, env);
  const specByName = new Map(commandSpecs.map((spec) => [spec.name, spec]));
  const children = new Map();
  const gatewayPort = Number.parseInt(env.PILOTDECK_GATEWAY_PORT || '18789', 10);
  const runtimeEnv = {
    ...env,
    PILOTDECK_COMPUTER_USE_MCP_CONFIG: computerUseMcpConfigPath(env),
    PILOTDECK_RESTART_MODE: normalizedMode,
    PILOTDECK_RESTART_SUPERVISOR: '1',
    PILOTDECK_RESTART_REQUEST_FILE: requestFile,
    PILOTDECK_RUNTIME_SUPERVISED: '1',
  };
  const configPath = resolveSupervisorConfigPath(env.PILOTDECK_CONFIG_PATH);
  if (configPath) runtimeEnv.PILOTDECK_CONFIG_PATH = configPath;
  else delete runtimeEnv.PILOTDECK_CONFIG_PATH;
  let configuration = null;
  let stopping = false;
  let handlingCriticalExit = false;
  let gatewayStopPromise = null;
  let gatewayRetryTimer = null;
  let gatewayReadinessAttempts = 0;
  let shutdownSignal = null;

  const clearGatewayRetry = () => {
    if (gatewayRetryTimer === null) return;
    clearTimeout(gatewayRetryTimer);
    gatewayRetryTimer = null;
  };

  const sendGatewayState = (state, gatewayError) => {
    const server = children.get('server');
    if (!server || typeof server.send !== 'function' || server.connected === false) return;
    try {
      server.send({
        type: 'pilotdeck:gateway-state',
        state,
        ...(gatewayError ? { error: gatewayError } : {}),
      });
    } catch (sendError) {
      error(`[runtime-supervisor] Failed to publish Gateway state: ${sendError.message}`);
    }
  };

  const spawnProcess = (name) => {
    const spec = specByName.get(name);
    if (!spec) throw new Error(`Unknown runtime process: ${name}`);
    const child = spawnImpl(spec.command, spec.args, {
      cwd: spec.cwd,
      stdio: spec.ipc ? ['inherit', 'inherit', 'inherit', 'ipc'] : 'inherit',
      env: runtimeEnv,
      windowsHide: platform === 'win32',
    });
    children.set(name, child);
    return { child, spec };
  };

  const stopChild = (name, signal = 'SIGTERM') => {
    const child = children.get(name);
    if (!child) return Promise.resolve();
    children.delete(name);
    if (child.exitCode != null) return Promise.resolve();
    return new Promise((resolveStop) => {
      let settled = false;
      let timer;
      let forceExitTimer;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(forceExitTimer);
        resolveStop();
      };
      timer = setTimeout(() => {
        if (child.exitCode == null) child.kill('SIGKILL');
        forceExitTimer = setTimeout(finish, 1_000);
      }, 3_000);
      child.once('close', finish);
      if (!child.killed) child.kill(signal);
    });
  };

  const stopAll = (signal = 'SIGTERM') => {
    clearGatewayRetry();
    const pendingStops = [...children.keys()]
      .reverse()
      .map((name) => stopChild(name, signal));
    if (gatewayStopPromise) pendingStops.push(gatewayStopPromise);
    return Promise.all(pendingStops);
  };

  const stopGateway = (signal = 'SIGTERM') => {
    if (!children.has('gateway')) return gatewayStopPromise ?? Promise.resolve();
    gatewayStopPromise = stopChild('gateway', signal).finally(() => {
      gatewayStopPromise = null;
    });
    return gatewayStopPromise;
  };

  const startGateway = () => {
    if (configuration?.state !== 'ready' || children.has('gateway') || stopping) return;
    if (gatewayStopPromise) {
      void gatewayStopPromise.then(() => startGateway());
      return;
    }
    clearGatewayRetry();
    gatewayReadinessAttempts += 1;
    const attempt = gatewayReadinessAttempts;
    // 第一次给足冷启动时间；重试那次进程已预热，用更短的窗口，别让用户干等。
    const readinessTimeout = attempt === 1 ? GATEWAY_READINESS_TIMEOUT_MS : GATEWAY_RETRY_TIMEOUT_MS;
    sendGatewayState('starting');
    const { child } = spawnProcess('gateway');
    let reportedFailure = false;
    let portReady = false;
    let processReady = false;
    let readinessPublished = false;
    const publishReady = () => {
      if (!portReady || !processReady || readinessPublished || reportedFailure || children.get('gateway') !== child) return;
      readinessPublished = true;
      gatewayReadinessAttempts = 0;
      clearTimeout(readinessTimer);
      log(`[runtime-supervisor] Gateway ready on 127.0.0.1:${gatewayPort}`);
      sendGatewayState('ready');
    };
    const failReadiness = waitError => {
      if (children.get('gateway') !== child || reportedFailure || readinessPublished) return;
      reportedFailure = true;
      clearTimeout(readinessTimer);
      const detail = waitError instanceof Error ? waitError.message : String(waitError);
      if (attempt < GATEWAY_READINESS_MAX_ATTEMPTS && !stopping) {
        error(`[runtime-supervisor] Gateway failed readiness check (attempt ${attempt}/${GATEWAY_READINESS_MAX_ATTEMPTS}): ${detail}; restarting it once`);
        void stopGateway().then(() => {
          if (stopping) return;
          gatewayRetryTimer = setTimeout(() => {
            gatewayRetryTimer = null;
            startGateway();
          }, GATEWAY_RETRY_DELAY_MS);
          gatewayRetryTimer.unref?.();
        });
        return;
      }
      void stopGateway();
      error(`[runtime-supervisor] Gateway failed readiness check: ${detail}`);
      sendGatewayState('error', detail);
    };
    const readinessTimer = setTimeout(() => failReadiness(new Error('Timed out waiting for the managed Gateway to become ready.')), readinessTimeout);
    readinessTimer.unref?.();
    child.on('message', message => {
      // A pre-existing listener may occupy this port. Only our child can
      // confirm that it finished initialization and bound the expected port.
      if (message?.type !== 'pilotdeck:gateway-ready' || message.port !== gatewayPort) return;
      processReady = true;
      publishReady();
    });

    child.once('error', (spawnError) => {
      clearTimeout(readinessTimer);
      if (children.get('gateway') !== child) return;
      children.delete('gateway');
      reportedFailure = true;
      const detail = `Failed to start Gateway: ${spawnError.message}`;
      error(`[runtime-supervisor] ${detail}`);
      sendGatewayState('error', detail);
    });
    child.once('close', (code, signal) => {
      clearTimeout(readinessTimer);
      if (children.get('gateway') !== child) return;
      children.delete('gateway');
      if (stopping || reportedFailure) return;
      // V8 heap exhaustion aborts the process with SIGABRT. Emit a
      // machine-readable code so the UI says "out of memory" instead of the
      // generic "stopped unexpectedly" message.
      const detail = signal === 'SIGABRT'
        ? `PD_RUNTIME_OUT_OF_MEMORY: Gateway exited code=${code ?? 'null'} signal=${signal ?? 'null'}`
        : `Gateway exited code=${code ?? 'null'} signal=${signal ?? 'null'}`;
      error(`[runtime-supervisor] ${detail}`);
      sendGatewayState('error', detail);
    });

    waitForPortImpl(gatewayPort, '127.0.0.1', readinessTimeout)
      .then(() => {
        portReady = true;
        publishReady();
      })
      .catch(failReadiness);
  };

  const handleServerMessage = (message) => {
    if (message?.type === 'pilotdeck:server-ready') {
      if (normalizedMode !== 'dev' || children.has('client') || stopping) return;
      if (!Number.isInteger(message.port) || message.port < 1 || message.port > 65535) return;
      // Vite must not proxy to an unbound or fallback-abandoned server port.
      runtimeEnv.SERVER_PORT = String(message.port);
      const { child } = spawnProcess('client');
      watchCriticalChild('client', child);
      return;
    }
    if (message?.type === 'pilotdeck:configuration-state' && message.configuration) {
      configuration = message.configuration;
      if (configuration.state === 'ready') {
        startGateway();
      } else {
        gatewayReadinessAttempts = 0;
        clearGatewayRetry();
        void stopGateway();
        sendGatewayState('stopped');
      }
      return;
    }
    if (message?.type === 'pilotdeck:retry-gateway' && configuration?.state === 'ready') {
      // 用户手动点「重新启动」时给一份完整的重试预算，不继承上一次的失败计数。
      gatewayReadinessAttempts = 0;
      clearGatewayRetry();
      // startGateway() has a children.has('gateway') guard: if a stale child
      // is still registered (e.g. stuck in "starting"), calling it directly
      // silently returns and the Restart button appears to do nothing.
      // Only take the async stop→start path when a stale child really exists;
      // the common case stays synchronous.
      if (children.has('gateway')) {
        void stopGateway().then(() => {
          if (!stopping) startGateway();
        });
      } else {
        startGateway();
      }
    }
  };

  const handleCriticalExit = async (code, signal) => {
    if (handlingCriticalExit) return;
    handlingCriticalExit = true;
    stopping = true;
    await stopAll();

    if (shutdownSignal) {
      exit(shutdownSignal === 'SIGINT' ? 0 : 1);
      return;
    }

    if (exists(requestFile)) {
      try {
        unlink(requestFile);
      } catch (unlinkError) {
        error(`[runtime-supervisor] Failed to consume restart request: ${unlinkError.message}`);
        exit(1);
        return;
      }
      log(`[runtime-supervisor] Restart requested; relaunching ${normalizedMode} runtime...`);
      handlingCriticalExit = false;
      startRuntime();
      return;
    }

    if (code === RESTART_EXIT_CODE) {
      error('[runtime-supervisor] Restart exit code received without a restart request file.');
    }
    exit(typeof code === 'number' ? code : (signal ? 1 : 0));
  };

  const watchCriticalChild = (name, child) => {
    child.once('error', (spawnError) => {
      if (children.get(name) !== child || handlingCriticalExit) return;
      error(`[runtime-supervisor] Failed to start ${name}: ${spawnError.message}`);
      void handleCriticalExit(1, null);
    });
    child.once('close', (code, signal) => {
      if (children.get(name) !== child || stopping || handlingCriticalExit) return;
      children.delete(name);
      void handleCriticalExit(code, signal);
    });
  };

  const startRuntime = () => {
    stopping = false;
    configuration = null;
    const { child: server } = spawnProcess('server');
    server.on('message', message => {
      if (children.get('server') === server) handleServerMessage(message);
    });
    watchCriticalChild('server', server);
  };

  const stop = async (signal) => {
    shutdownSignal = signal;
    if (stopping) return;
    stopping = true;
    await stopAll(signal);
    exit(signal === 'SIGINT' ? 0 : 1);
  };

  const run = () => {
    processLike.on('SIGINT', () => void stop('SIGINT'));
    processLike.on('SIGTERM', () => void stop('SIGTERM'));
    startRuntime();
  };

  return {
    run,
    stop,
    startGateway,
    get child() {
      return children.get('server') ?? null;
    },
    get children() {
      return new Map(children);
    },
    requestFile,
    commandSpecs,
  };
}

export function runSupervisor(argv = process.argv.slice(2)) {
  const mode = normalizeSupervisorMode(argv[0]);
  const requestFile = getRestartRequestFile({
    env: { ...process.env, PILOTDECK_RESTART_MODE: mode },
    pid: process.pid,
    tmpdir: () => path.join(os.tmpdir(), 'pilotdeck'),
  });
  createRuntimeSupervisor({ mode, requestFile }).run();
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  runSupervisor();
}
