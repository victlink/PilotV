// gateway-keeper 的判定核心 —— 纯函数，不碰进程和网络。
//
// keeper 在监督链里的位置（docs/HANDOFF-Windows-20261105.md §3.4）：
//   3001 (Web/API) → 本插件 server.mjs → .run/agent-supervisor.cmd → detached gateway
//
// 它只干一件事：保证「有一个 supervisor 在看着 gateway」。
// 刻意不把 supervisor 的判读逻辑搬进来 —— 重启退避、/healthz 判读、单实例锁
// 全在 service/supervisorPolicy.mjs 和 agent-supervisor.mjs 里。keeper 要是也
// 自己判一遍「gateway 健康吗、该不该重启」，就变成了两套口径，而这两套一旦不
// 一致，现象是「两个东西互相重启对方」，比没有 keeper 更难查。
//
// 单实例由 supervisor 自己的 18790 TCP 锁兜底：keeper 重复拉起不会变成两个
// supervisor，第二个会进 standby。所以 keeper 判错了最坏也只是多起一个 standby，
// 不会把 gateway 搞成震荡。

export const LOCK_PORT = 18790;
export const SUPERVISOR_REL = ['.run', 'agent-supervisor.mjs'];

/**
 * 找到这台机器上的 PilotV 仓库根。
 *
 * 不能靠 env：插件进程是被 ui/server 用一份裁剪过的 env 起的
 * （只有 PATH / HOME / NODE_ENV / PLUGIN_NAME，见
 * ui/server/utils/plugin-process-manager.js），WorkBuddy 注入的那些变量一个都
 * 传不进来，而且 Windows 上 HOME 经常是空的。所以顺序是：
 *   1. 配置文件（`pilotv setup` 写的那份，最明确）
 *   2. 环境变量 PILOTV_HOME（手工跑时有用）
 *   3. 常见安装位置（兜底，且必须能证明它确实是仓库）
 * 「证明是仓库」靠锚点文件，而不是靠目录名 —— 目录名可以随便改，
 * service/pilotv_gateway.mjs 在才说明这真是一个 PilotV checkout。
 */
export function resolveRepoRoot({ config, env = {}, candidates = [], anchorExists } = {}) {
  const anchor = anchorExists || (() => false);
  const fromConfig = typeof config?.repoRoot === 'string' ? config.repoRoot.trim() : '';
  if (fromConfig) {
    if (anchor(fromConfig)) return { root: fromConfig, source: 'config' };
    // 配置文件里写了但那个目录已经不是仓库了：不能退到兜底猜测。
    // 装错仓库比装不上更贵 —— 它会去起另一台机器上的服务。
    return { root: null, source: 'config', rejected: fromConfig };
  }
  const fromEnv = typeof env.PILOTV_HOME === 'string' ? env.PILOTV_HOME.trim() : '';
  if (fromEnv) {
    if (anchor(fromEnv)) return { root: fromEnv, source: 'env' };
    return { root: null, source: 'env', rejected: fromEnv };
  }
  for (const candidate of candidates) {
    if (candidate && anchor(candidate)) return { root: candidate, source: 'candidate' };
  }
  return { root: null, source: 'none' };
}

/**
 * keeper 每一步该做什么。三态与 deploy/setup 保持一致：
 * 满足 → skip，不满足 → run，没探到 → run 但文案不许说成「不满足」。
 */
export function decideKeeperAction({ lockReachable, repoRoot, nowMs = 0, lastSpawnMs = null, minSpawnGapMs = 30000 } = {}) {
  if (!repoRoot) {
    return {
      action: 'blocked',
      why: '找不到 PilotV 仓库根：跑一次 pilotv setup，或写 ~/.pilotdeck/gateway-keeper.json 指定 repoRoot',
    };
  }
  if (lockReachable === true) {
    return { action: 'idle', why: `已有 supervisor 持有 :${LOCK_PORT} 单实例锁，keeper 不重复拉起` };
  }
  if (lockReachable === undefined) {
    return { action: 'wait', why: `:${LOCK_PORT} 探测没出结果，本轮不动手（探测失败不等于没人跑）` };
  }
  const sinceSpawn = lastSpawnMs === null ? null : nowMs - lastSpawnMs;
  if (sinceSpawn !== null && sinceSpawn < minSpawnGapMs) {
    // 拉起后 supervisor 自己要建锁，短窗口内探不到锁是正常的。
    // 没有这个冷却，keeper 会变成紧循环 spawn —— 这正是当年 agent.log 涨到
    // 1.82 GB 的成因之一。
    return { action: 'cooldown', why: `${Math.round(minSpawnGapMs - sinceSpawn)}ms 前刚拉起过，等它建锁`, sinceSpawnMs: sinceSpawn };
  }
  return { action: 'spawn', why: `:${LOCK_PORT} 无人持有，说明没有 supervisor 在看着 gateway` };
}

/** 锁探测的结果 → 三态。连上是 true，明确被拒是 false，其它是 undefined（未知）。 */
export function classifyLockProbe({ connected, errorCode } = {}) {
  if (connected) return true;
  if (errorCode === 'ECONNREFUSED' || errorCode === 'ENOTFOUND') return false;
  return undefined;
}

/**
 * 配置层叠：用户目录覆盖插件包内的默认值。
 *
 * 方向不能反。`pilotv setup` 写的是 ~/.pilotdeck/gateway-keeper.json，
 * 它必须赢过插件包里可能带的任何默认值；反过来的话，升级插件就会把这台
 * 机器的仓库指定静静改掉。非对象（读不到 / JSON 坏了）按空对象处理，
 * 不能让一个坏配置文件把 keeper 整个打死。
 */
export function mergeKeeperConfig({ userConfig, localConfig } = {}) {
  const plain = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : {});
  return { ...plain(localConfig), ...plain(userConfig) };
}
/**
 * 把判定落成「要不要真动手」。
 *
 * dryRun 不是为测试造的开关：它对应的运维场景是「我先看看 keeper 到底会干什么」。
 * keeper 的动作会起进程，有个只观察模式才敢在别人机器上开。
 * 判定照旧算并且如实报告，只是不执行——把 dryRun 实现成「直接不判了」的话，
 * 就看不到它本来会做什么，这个模式就没意义了。
 */
export function planKeeperStep(decision, { dryRun = false } = {}) {
  if (decision.action !== 'spawn') return { ...decision, executed: false };
  return dryRun
    ? { ...decision, action: 'dry-run', executed: false, why: `${decision.why}（dry-run，未拉起）` }
    : { ...decision, executed: true };
}
/** ui/server 要求插件在 10 秒内往 stdout 打印这一行，否则判启动失败并 kill。 */
export function readyLine(port) {
  const n = Number(port);
  if (!Number.isInteger(n) || n <= 0 || n > 65535) throw new Error(`ready 行需要合法端口，收到 ${port}`);
  return `${JSON.stringify({ ready: true, port: n })}\n`;
}

/** 给插件前端看的状态。刻意不含任何凭据、也不含绝对路径以外的敏感信息。 */
export function statusPayload({ repoRoot, lockReachable, action, why, spawnCount, lastSpawnMs, supervisorPid, dryRun }) {
  return {
    repoRoot: repoRoot || null,
    // dryRun 必须可见：否则面板上写着 dry-run 而实际在起进程，或反过来，
    // 都无从发现。配置生效与否要能直接看到。
    dryRun: dryRun === true,
    lockPort: LOCK_PORT,
    supervisorRunning: lockReachable === true,
    lockProbe: lockReachable === true ? 'reachable' : lockReachable === false ? 'refused' : 'unknown',
    lastAction: action || null,
    lastWhy: why || null,
    spawnCount: Number(spawnCount) || 0,
    lastSpawnMs: lastSpawnMs ?? null,
    supervisorPid: supervisorPid ?? null,
  };
}

/** 默认候选位置。写死某台机器 = 换设备时这条路必然不通。 */
export function defaultRepoCandidates({ homedir = '', env = {} } = {}) {
  const list = [];
  if (homedir) {
    list.push(homedir + '/PilotV', homedir + '/projects/pilotv', homedir + '/Documents/Work/PilotV');
  }
  if (env.USERPROFILE) {
    list.push(env.USERPROFILE + '\\PilotV', env.USERPROFILE + '\\projects\\pilotv');
  }
  return list;
}