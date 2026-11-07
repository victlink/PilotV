// gateway-keeper 的前端面板。
//
// 加载方式决定了写法（ui/src/components/plugins/view/PluginTabContent.tsx）：
// 宿主把这份文件当文本取回来，包成 Blob URL 再 import()。所以：
//   * 必须是 ES module，导出 mount / unmount；
//   * 不能 import 任何东西 —— Blob URL 解析不了相对路径，裸模块名也不可能命中；
//   * 不能依赖构建工具，仓库里不需要给它配打包。
// 后端一律走 api.rpc()，由宿主转发到 server.mjs，前端不自己猜端口。
const ROOT_STYLE = 'padding:16px;font:13px/1.6 system-ui,sans-serif;max-width:640px';
const CARD_STYLE = 'border:1px solid rgba(128,128,128,.35);border-radius:8px;padding:12px 14px;margin:0 0 12px';
const ROW_STYLE = 'display:flex;gap:8px;align-items:baseline;margin:2px 0';
const KEY_STYLE = 'min-width:120px;opacity:.65';
const OK_STYLE = 'color:#16a34a;font-weight:600';
const WARN_STYLE = 'color:#d97706;font-weight:600';
const BAD_STYLE = 'color:#dc2626;font-weight:600';

function row(key, value, style) {
  const wrap = document.createElement('div');
  wrap.setAttribute('style', ROW_STYLE);
  const k = document.createElement('span');
  k.setAttribute('style', KEY_STYLE);
  k.textContent = key;
  const v = document.createElement('span');
  v.setAttribute('style', style || '');
  v.textContent = value === null || value === undefined || value === '' ? '-' : String(value);
  wrap.append(k, v);
  return wrap;
}

function render(root, status, note) {
  root.replaceChildren();
  const wrap = document.createElement('div');
  wrap.setAttribute('style', ROOT_STYLE);

  const title = document.createElement('h2');
  title.textContent = 'Gateway Keeper';
  title.setAttribute('style', 'font-size:15px;margin:0 0 10px');
  wrap.append(title);

  const card = document.createElement('div');
  card.setAttribute('style', CARD_STYLE);
  const running = status && status.supervisorRunning;
  card.append(row('supervisor',
    running ? 'running' : status && status.lockProbe === 'unknown' ? 'unknown' : 'not running',
    running ? OK_STYLE : status && status.lockProbe === 'unknown' ? WARN_STYLE : BAD_STYLE));
  if (status) {
    card.append(row('单实例锁端口', status.lockPort));
    if (status.dryRun) card.append(row('模式', 'dry-run（只判不动手）', WARN_STYLE));
    card.append(row('仓库根', status.repoRoot));
    card.append(row('本轮判定', status.lastAction,
      status.lastAction === 'blocked' ? BAD_STYLE : status.lastAction === 'spawn' ? WARN_STYLE : OK_STYLE));
    card.append(row('依据', status.lastWhy));
    card.append(row('累计拉起', status.spawnCount));
    card.append(row('supervisor pid', status.supervisorPid));
    if (status.lastError) card.append(row('最近错误', status.lastError, WARN_STYLE));
  }
  wrap.append(card);

  if (note) {
    const err = document.createElement('div');
    err.setAttribute('style', `${CARD_STYLE};${BAD_STYLE}`);
    err.textContent = note;
    wrap.append(err);
  }

  const hint = document.createElement('p');
  hint.setAttribute('style', 'opacity:.7;margin:0');
  hint.textContent = '这里只读。重启退避与 /healthz 判读在 .run/agent-supervisor.mjs，改行为请改那里。';
  wrap.append(hint);
  root.append(wrap);
}

export async function mount(container, api) {
  let alive = true;
  let timer = null;
  let lastNote = '';

  const refresh = async () => {
    try {
      const status = await api.rpc('GET', '/status');
      if (!alive) return;
      lastNote = '';
      render(container, status, '');
    } catch (error) {
      if (!alive) return;
      // keeper 进程没起来时面板不该整块空白：那看起来像插件坏了，
      // 而真实原因往往是仓库根没找到（server.mjs 启动即退出）。
      lastNote = `读不到 keeper：${String(error && error.message ? error.message : error)}`;
      render(container, null, lastNote);
    }
  };

  await refresh();
  timer = setInterval(refresh, 10000);
  container.__keeperCleanup = () => {
    alive = false;
    if (timer) clearInterval(timer);
    timer = null;
  };
}

export function unmount(container) {
  try { container.__keeperCleanup?.(); } catch { /* 清理失败不该挡住切页 */ }
  delete container.__keeperCleanup;
  container.replaceChildren();
}