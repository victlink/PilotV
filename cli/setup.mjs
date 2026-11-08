// pilotv setup —— 空白设备从 clone 到可用，一条命令。
//
// 和 deploy 一样：这里只出计划，不执行。执行在 setup-command.mjs。
// 这么拆的理由也一样 —— 「装机会不会把机器搞坏」这件事必须能被读代码回答，
// 而不是只能通过在真机上跑一遍来回答。
//
// 它收编的是散在四处的手工步骤（HANDOFF §3.1/§3.4）：
//   start-windows.ps1      起四服务
//   scripts/pilotv-boot.cmd + Startup\PilotV.vbs / 计划任务   登录自启
//   scripts/make_tls_cert.sh / renew_gateway_tls.ps1          证书
//   ~/.pilotdeck/plugins/gateway-keeper                       插件（此前不在仓库）
// 这些各自都幂等，但「先跑哪个、跑过没有」只存在于某个人的记忆里。
//
// 三态事实（satisfied / unsatisfied / 未确认）沿用 deploy.mjs：把「没探到」说成
// 「不满足」是撒谎，会把一台其实装好了的远端设备说成缺一堆东西。

export const SERVICES = [
  { port: 8799, name: '成果台 API', required: true },
  { port: 18789, name: 'agent gateway', required: true },
  { port: 3001, name: 'Web/API 服务', required: true },
  { port: 5186, name: '前端网关 (HTTPS)', required: true },
];

export const PLUGIN_NAME = 'gateway-keeper';
export const TASK_NAME = 'PilotV-Startup';

function step({ key, title, satisfied, why, todo, command, tier, risk }) {
  const known = satisfied !== null && satisfied !== undefined;
  return {
    key,
    title,
    known,
    satisfied: satisfied === true,
    // 未知按「要做」处理：setup 的每一步都设计成可重复跑，多跑一次无害。
    action: satisfied === true ? 'skip' : 'run',
    why: satisfied === true ? why : known ? todo : `未确认（探不到实况）：${todo}`,
    ...(command ? { command } : {}),
    tier: tier || 'local',
    risk: risk || 'low',
  };
}

/**
 * 装机计划。顺序有意义：前一步没成，后面的失败信息才有意义。
 * 例如证书没签就去起前端网关，得到的是「网关起不来」而不是「缺证书」。
 */
export function planSetup({ facts = {}, platform = process.platform } = {}) {
  const isWin = platform === 'win32';
  const steps = [];

  steps.push(step({
    key: 'runtime',
    title: '运行时就位（.venv + node_modules + ui/dist）',
    satisfied: facts.runtimeReady,
    why: `Python venv、依赖与前端构建产物都在${facts.uiDistMtime ? `（dist 更新于 ${facts.uiDistMtime}）` : ''}`,
    todo: '建 .venv 并装 requirements、装 upstream 依赖、构建 ui/dist。缺 dist 时网关只能托管上一版界面，现象是「改了没生效」',
    tier: 'local',
  }));

  steps.push(step({
    key: 'cert',
    title: 'TLS 证书（安卓装桌面应用的前置）',
    satisfied: facts.certReady,
    why: facts.certDaysRemaining !== undefined && facts.certDaysRemaining !== null
      ? `证书有效，剩余 ${facts.certDaysRemaining} 天`
      : '证书已在位',
    todo: isWin
      ? '签自签证书，SAN 要同时含本机 IP 与 MagicDNS 域名；没有它前端网关起不来，且安卓 Chrome 拒绝安装桌面快捷方式'
      : '签自签证书（make_tls_cert.sh），SAN 要同时含 IP 与 MagicDNS 域名',
    tier: 'local',
  }));

  steps.push(step({
    key: 'manifest',
    title: '设备清单 public/dist 两份一致',
    satisfied: facts.manifestInSync,
    why: '两份内容一致，且不含模板占位符',
    todo: '把 ui/public/devices.json 同步到 ui/dist/devices.json。不一致时下拉列表和代理白名单会各说一套，表现为「切过去但 401」',
    command: 'pilotv doctor --fix-manifest',
    tier: 'local',
  }));

  steps.push(step({
    key: 'plugin',
    title: `gateway-keeper 插件安装到用户目录`,
    satisfied: facts.pluginInstalled,
    why: `${PLUGIN_NAME} 已装，且与仓库内版本一致`,
    todo: `把 plugins-src/${PLUGIN_NAME} 拷到 ~/.pilotdeck/plugins/${PLUGIN_NAME}。没有它，gateway 挂掉后没人再拉起 supervisor`,
    tier: 'local',
  }));

  steps.push(step({
    key: 'autostart',
    title: isWin ? `登录自启（计划任务 ${TASK_NAME}）` : '登录自启（systemd user 服务）',
    satisfied: facts.autostartInstalled,
    why: isWin ? `计划任务 ${TASK_NAME} 已注册，且 Startup 下没有并存的 .vbs` : '自启单元已启用',
    // 两套自启并存会互相打架（HANDOFF 事故 3），所以这一步的「满足」包含
    // 「只有一套」，不只是「有一套」。
    todo: isWin
      ? `注册计划任务 ${TASK_NAME}；若 Startup 下还有 PilotV.vbs，改名为 .disabled（可逆）。两套并存时会互相重启对方`
      : '写 systemd user 单元并 enable；node 的绝对路径必须写死，服务环境的 PATH 和登录 shell 不是一套',
    tier: 'system',
    risk: 'medium',
  }));

  steps.push(step({
    key: 'services',
    title: `四服务在跑（${SERVICES.filter(s => s.required).map(s => `:${s.port}`).join(' / ')}）`,
    satisfied: facts.servicesUp,
    why: '四个必需端口都在听',
    todo: '起四服务。注意 3001 是 Express 的 Web/API，不能把 agent gateway 开在它上面 —— 那样页面能渲染但每个 /api/* 都会拿到 SPA 兜底 HTML',
    command: isWin ? '.\\start-windows.ps1' : './start.sh',
    tier: 'service',
    risk: 'medium',
  }));

  steps.push(step({
    key: 'verify',
    title: '自检收口（pilotv doctor）',
    satisfied: facts.doctorClean,
    why: 'doctor 没有失败项',
    todo: '跑 pilotv doctor。装完不体检等于没装：这一步是前面所有「我觉得装好了」的裁判',
    command: 'pilotv doctor',
    tier: 'local',
  }));

  return steps;
}

/** 计划的人话输出。tier/risk 要显示出来：高风险那几步得让人先看见再决定。 */
export function formatSetupPlan(steps, { device = '本机', color = false } = {}) {
  // 转义写而不是裸 ESC 字节：对齐 doctor.mjs。控制字符进源文件会让它在
  // 工具链里看起来像二进制，也容易被误删。
  const paint = (text, kind) => {
    if (!color) return text;
    const code = { done: '32', todo: '31', unknown: '33', dim: '2' }[kind];
    return `\u001b[${code}m${text}\u001b[0m`;
  };
  const lines = [`装机计划 · ${device}`, ''];
  for (const entry of steps) {
    const kind = entry.satisfied ? 'done' : entry.known ? 'todo' : 'unknown';
    const mark = paint(entry.satisfied ? 'OK  ' : entry.known ? 'TODO' : '?   ', kind);
    const tail = entry.tier === 'local' ? '' : paint(`  [${entry.tier}/${entry.risk}]`, 'dim');
    lines.push(`${mark} ${entry.key.padEnd(10)} ${entry.title}${tail}`);
    lines.push(`  ${paint(entry.why, 'dim')}`);
    if (entry.action === 'run' && entry.command) lines.push(`  ${paint(`→ ${entry.command}`, 'dim')}`);
  }
  const todo = steps.filter((entry) => entry.action === 'run');
  const risky = todo.filter((entry) => entry.risk !== 'low');
  lines.push('');
  lines.push(todo.length === 0
    ? paint('全部满足 —— 这台设备已经装好了', 'done')
    : paint(`待办 ${todo.length} 项` + (risky.length ? `，其中 ${risky.length} 项会改动系统状态` : ''), 'todo'));
  if (todo.length > 0) lines.push(paint('   计划是幂等的：重跑只会补缺的那几步。', 'dim'));
  return lines.join('\n');
}

/**
 * 「这台设备装好了吗」的一句话结论。
 * 刻意区分「都满足」和「没法判断」：把后者说成前者，运维会带着错误结论走开。
 */
export function setupVerdict(steps) {
  const todo = steps.filter((entry) => entry.action === 'run');
  const unknown = steps.filter((entry) => !entry.known);
  if (todo.length === 0) return { ok: true, summary: '已就绪' };
  if (unknown.length === steps.length) {
    return { ok: false, summary: `一项都没探到实况（${steps.length} 项），别当成「都缺」` };
  }
  return { ok: false, summary: `还差 ${todo.length} 项${unknown.length ? `（其中 ${unknown.length} 项未确认）` : ''}` };
}

/**
 * 插件该装在哪、装什么。
 * 只认 manifest 里点名的文件：多拷一个文件，下次升级就会出现「仓库里没有但线上
 * 还在生效」的幽灵副本。
 */
export function pluginInstallPlan({ manifest, pluginName = PLUGIN_NAME } = {}) {
  const files = ['manifest.json'];
  if (typeof manifest?.entry === 'string') files.push(manifest.entry);
  if (typeof manifest?.server === 'string') files.push(manifest.server);
  // keeper-core.mjs 是 server.mjs 的相对 import。宿主用 cwd=pluginDir 起进程，
  // 漏了它插件会「启动即退出」，而面板只显示「读不到 keeper」。
  if (files.includes('server.mjs')) files.push('keeper-core.mjs');
  const unique = [...new Set(files)];
  return {
    name: pluginName,
    files: unique,
    dirName: pluginName,
  };
}