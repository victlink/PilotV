/* PilotV 成果台 —— 三栏交互 + 真实数据层
 *
 * 数据层：GET /api/artifacts 拉列表，GET /api/artifacts/events 收 SSE。
 * 服务端是唯一事实源：前端不缓存业务状态，只缓存渲染结果，
 * 任何写操作都走 REST，写完由 SSE 回推确认（不做乐观更新，避免两处真相）。
 *
 * 约定：
 *   - 只读 DOM，不引框架；风格对齐 console-app.js（无 emoji、单字符字形图标）。
 *   - 颜色一律来自 CSS 变量，本文件不写死色值。
 */
(function () {
  'use strict';

  const API = '/api/artifacts';
  const THEME_KEY = 'pdconsole.theme.v1';
  /* 下拉选择要跨开页保留：成果台经常挂在后台，刷新一次就丢掉「我在看哪个
     对话」是很烦人的。用户手动选过一次之后，就以他的选择为准。 */
  const SCOPE_KEY = 'pdconsole.artscope.v1';
  const $ = (id) => document.getElementById(id);
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /* 类型：单字符字形 + 筛选名（§2，禁止 emoji） */
  const KINDS = [
    { id: 'all',    label: '全部', icon: '▤' },
    { id: 'page',   label: '页面', icon: '▣' },
    { id: 'image',  label: '图片', icon: '▤' },
    { id: 'video',  label: '视频', icon: '▶' },
    { id: 'drawing',label: '图纸', icon: '⌗' },
    { id: 'model3d',label: '三维', icon: '◈' },
    { id: 'doc',    label: '文档', icon: '▧' },
  ];
  const KIND_ICON = Object.fromEntries(KINDS.map((k) => [k.id, k.icon]));
  const KIND_LABEL = Object.fromEntries(KINDS.map((k) => [k.id, k.label]));

  /* 服务端状态 → 前端展示态。pending/ready 都算「还没人看过」，合成 new，
     否则顶栏统计会把刚发布的成果算进「评审中」，误导判断。 */
  const STATUS_MAP = {
    pending: 'new',
    ready: 'new',
    reviewing: 'reviewing',
    approved: 'approved',
    rework: 'changes_requested',
    rejected: 'rejected',
  };

  const STATUS_TEXT = {
    new: '新成果',
    reviewing: '评审中',
    approved: '已通过',
    changes_requested: '待返工',
  };
  

  /* ------------------------------------------------------------ 主题 */
  function applyTheme() {
    let t = 'dark';
    try { t = localStorage.getItem(THEME_KEY) || 'dark'; } catch { /* 隐私模式用默认 */ }
    document.documentElement.dataset.theme = t === 'light' ? 'light' : 'dark';
    syncThemeBtn();
  }
  function toggleTheme() {
    const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
    try { localStorage.setItem(THEME_KEY, next); } catch { /* 忽略 */ }
    document.documentElement.dataset.theme = next;
    syncThemeBtn();
  }
  function syncThemeBtn() {
    const b = $('btnTheme');
    if (b) b.textContent = document.documentElement.dataset.theme === 'light' ? '☀' : '☾';
  }

  /* ------------------------------------------------------------ 数据层 */
  /* 服务端成果 → 前端渲染模型。
     一处映射，渲染层只认前端字段；服务端加字段不会波及渲染。 */
  function normalize(a) {
    const entry = a.entry || {};
    const meta = entry.meta || {};
    return {
      id: a.id,
      kind: a.kind,
      title: a.title,
      sub: a.sub || (meta.w ? `${meta.w}×${meta.h}` : ''),
      version: a.version || 1,
      parent_id: a.parent_id || '',
      agent: a.agent || 'pilotdeck',
      project: a.project || '',
      status: STATUS_MAP[a.status] || 'new',
      raw: a.status,
      src: entry.url || '',
      mime: a.mime || entry.mime || '',
      live: entry.html_url || '',
      thumb: entry.thumb_url || '',
      created_at: a.ts,
      updated_at: a.updated_at,
      open_notes: a.open_notes || 0,
      annotations: (a.annotations || []).map(normalizeNote),
      /* 列表接口不返回标注（省 N+1），只有单条接口才有。
         没加载过就别当成「零条」渲染，否则舞台和右栏会假装没意见。 */
      _loaded: Array.isArray(a.annotations),
      /* 部件树（需求 2）与手工编辑状态（需求 4）都在 meta 里 */
      /* meta 要原样留着：视频的时长/帧率、图纸的页数都在这儿。
         以前 normalize 只挑了几个字段出传，videoFps/pdfPageCount 读 a.meta
         永远读到空 —— 功能写了但永远是默认值。 */
      meta,
      /* 服务端判定的展示属性（需求 1/4）：非最终产物和显示不出来的项默认收起。 */
      deliverable: a.deliverable || 'final',
      deliverable_reason: a.deliverable_reason || '',
      displayable: a.displayable !== false,
      displayable_reason: a.displayable_reason || '',
      /* 同名同大小的重复发布，用来把左栏折成一组 */
      dup_key: a.dup_key || '',
      parts: meta.parts || null,
      edited: !!meta.edited,
      edited_delta: meta.edited_delta || null,
      source_path: (a.source && a.source.path) || meta.source_path || '',
    };
  }

  function normalizeNote(n) {
    const anchor = n.anchor || {};
    return {
      id: n.id,
      seq: n.seq,
      surface: n.surface || 'image',
      severity: n.severity || 'minor',
      body: n.body || '',
      rect: anchor.rect || n.rect || null,
      anchor,
      selector: anchor.selector || '',
      resolved: n.status === 'resolved',
      status: n.status,
      carried_from: n.carried_from || '',
      created_at: n.created_at,
    };
  }

  async function req(method, path, body) {
    const opt = { method, headers: {}, credentials: 'same-origin' };
    if (body !== undefined) {
      opt.headers['Content-Type'] = 'application/json';
      opt.body = JSON.stringify(body);
    }
    const r = await fetch(path, opt);
    const text = await r.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch { data = { error: text.slice(0, 200) }; }
    /* 401 一律走登录闸门：console 没有登录页，光抛错的话页面上只会留一句
       "unauthorized"，人根本没法往下走。 */
    if (r.status === 401) {
      openGate(state.items.length
        ? '登录态已失效，重新登录即可继续评审'
        : '需要登录才能读取成果');
      throw new Error('unauthorized');
    }
    if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
    return data;
  }

  /* ------------------------------------------------------------ 登录闸门
     页面是空壳（html/css/js 不含成果数据），数据全走 REST 的 Cookie / Bearer /
     回环鉴权。所以这里只负责把人送进登录态：POST /api/login 拿到 Cookie 后重载，
     整页状态由服务端重新喂一遍，不做局部续传。 */
  function openGate(why) {
    const gate = $('artGate');
    if (!gate) return;
    if (why) $('artGateWhy').textContent = why;
    const user = $('artGateUser');
    if (user && !user.value) user.value = 'artifacts';
    gate.hidden = false;
    setTimeout(() => { const p = $('artGatePass'); if (p) p.focus(); }, 30);
  }

  function gateError(msg) {
    const err = $('artGateErr');
    const btn = $('artGateBtn');
    if (err) { err.textContent = msg || ''; err.hidden = !msg; }
    if (btn) { btn.disabled = false; btn.textContent = '登录'; }
  }

  async function submitGate(ev) {
    ev.preventDefault();
    const btn = $('artGateBtn');
    if (btn) { btn.disabled = true; btn.textContent = '登录中…'; }
    gateError('');
    try {
      const r = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: ($('artGateUser') || {}).value || '',
          password: ($('artGatePass') || {}).value || '',
        }),
      });
      if (!r.ok) {
        const t = await r.text();
        let msg = `HTTP ${r.status}`;
        try { msg = JSON.parse(t).error || msg; } catch { /* 原样带出 */ }
        gateError(msg === 'invalid credentials' ? '用户名或口令不对' : msg);
        return;
      }
      location.reload();
    } catch (err) {
      gateError('连不上服务：' + String(err.message || err));
    }
  }

  /* ------------------------------------------------------------------ 设置
     面板只做三件事：显示当前账号、改自己的登录口令、退出登录。
     刻意不做：显示/复制 API 令牌、显示会话密钥 —— 页面是公开空壳（见
     artifacts_console.py:_open_page_assets），回显密钥等于把钥匙挂在门上。 */
  function setSettingsOpen(on) {
    const panel = $('settingsPanel');
    if (!panel) return;
    panel.hidden = !on;
    $('btnSettings').setAttribute('aria-expanded', String(on));
    if (on) { loadMe(); document.addEventListener('keydown', onSettingsKey); }
    else { document.removeEventListener('keydown', onSettingsKey); }
  }

  function onSettingsKey(ev) { if (ev.key === 'Escape') setSettingsOpen(false); }

  function pwMsg(text, tone) {
    const box = $('pwMsg');
    if (!box) return;
    box.textContent = text || '';
    box.hidden = !text;
    box.dataset.tone = tone || 'err';
  }

  async function loadMe() {
    try {
      const me = await req('GET', `${API}/me`);
      $('meUser').textContent = me.username || '—';
      $('meVia').textContent = me.via === 'cookie' ? '网页登录（Cookie）' : (me.via || '—');
      $('meArtifacts').textContent = String(me.artifacts ?? '—');
      $('meToken').textContent = me.api_token_configured ? '已配置（在服务端文件里）' : '未配置';
      $('meNotify').textContent = me.notify_configured ? '已配置' : '未配置';
      if (me.password_min) {
        $('pwRule').textContent =
          `至少 ${me.password_min} 位，不能和旧口令或用户名相同。`;
      }
    } catch (err) {
      if (String(err.message || err) !== 'unauthorized') {
        $('meUser').textContent = '读取失败：' + String(err.message || err);
      }
    }
  }

  async function submitPassword(ev) {
    ev.preventDefault();
    const btn = $('pwSubmit');
    const oldPw = $('pwOld').value;
    const newPw = $('pwNew').value;
    const confirmPw = $('pwConfirm').value;
    pwMsg('');
    if (newPw !== confirmPw) { pwMsg('两次输入的新口令不一致'); return; }
    if (btn) { btn.disabled = true; btn.textContent = '提交中…'; }
    try {
      const out = await req('POST', `${API}/password`, {
        old_password: oldPw, new_password: newPw, new_password_confirm: confirmPw,
      });
      $('pwOld').value = ''; $('pwNew').value = ''; $('pwConfirm').value = '';
      pwMsg('已改好。' + (out.note || ''), 'ok');
    } catch (err) {
      pwMsg(String(err.message || err));
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = '改口令'; }
    }
  }

  async function logout() {
    try { await req('POST', '/api/logout'); } catch { /* 已经掉线也一样 */ }
    location.reload();
  }

  function bindSettings() {
    $('btnSettings').addEventListener('click', () => setSettingsOpen(true));
    $('btnSettingsClose').addEventListener('click', () => setSettingsOpen(false));
    $('settingsPanel').addEventListener('click', (ev) => {
      if (ev.target === ev.currentTarget) setSettingsOpen(false);   // 点遮罩关闭
    });
    $('pwForm').addEventListener('submit', submitPassword);
    $('btnLogout').addEventListener('click', logout);
  }

  function bindGate() {
    const form = $('artGateForm');
    if (form) form.addEventListener('submit', submitGate);
  }

  async function loadList() {
    try {
      /* 一次性拉全量再前端筛：筛选条的计数要靠全量数据算，
         按 kind 下推会让其他类型的 chip 计数直接消失。 */
      const [data, ws] = await Promise.all([
        req('GET', `${API}?limit=200`),
        req('GET', `${API}/workspace?limit=400`).catch((e) => {
          console.warn('[artifacts] 项目目录不可用', e);
          return null;
        }),
      ]);
      state.items = (data.artifacts || []).map(normalize);
      state.stats = data.stats || null;
      state.agents = data.agents || [];
      applyWorkspace(ws);
    } catch (err) {
      setLive('off');
      state.items = [];
      state.projects = [];
      /* 401 已经由 req() 弹登录闸门了；再挂一条「接口没连上 unauthorized」
         只会让人以为服务坏了。闸门开着时用登录态的说法。 */
      const unauthorized = String(err.message || err) === 'unauthorized';
      state.loadError = unauthorized ? '登录态已失效，请重新登录' : String(err.message || err);
    } finally {
      state.loading = false;
      renderAll();
    }
  }

  /* 目录树数据。服务端已经排好序（实时会话置顶、其余时间倒序），这里只接收。 */
  function applyWorkspace(ws) {
    if (!ws) { state.projects = []; return; }
    state.projects = ws.projects || [];
    state.defaultArtifactId = ws.default_artifact_id || '';
    state.liveArtifactId = ws.live_artifact_id || '';

    /* 还没加载过时套一次默认下拉（活跃 > 最近更新）。加载过一次就不再套：
       否则 SSE 每来一个成果就把用户的视线拽回默认对话，筛选会「自己跳回去」。 */
    if (!state.scope.touched) {
      const saved = state.scope.session;
      if (!saved) state.scope = Object.assign({ touched: false }, defaultScope());
      else {
        /* 记着的那个会话可能在别的 PilotDeck 家目录/项目里没了，对不上就退回默认 */
        const hit = (state.projects || []).some(
          (p) => p.name === state.scope.project && (p.sessions || []).some((s) => s.id === saved));
        if (!hit) state.scope = Object.assign({ touched: false }, defaultScope());
      }
    }
    renderScope();
  }

  /* 首屏默认选中「正在实时修改」的那条；没有就选目录里最新的一条。
     用 pending 而不是直接 select()，是为了等第一次列表渲染完成再落位，
     否则 renderStage() 会拿着空数据渲染一次再被覆盖。 */
  function ensureSelection() {
    if (state.selectedId && allArts().some((a) => a.id === state.selectedId)) return;
    const want = state.liveArtifactId || state.defaultArtifactId;
    const pool = allArts();
    if (want && pool.some((a) => a.id === want)) { select(want); return; }
    if (pool.length) select(pool[0].id);
  }

  /* 单条刷新：标注事件只带部分字段时用它补齐，避免整列表重拉导致滚动位置跳。 */
  async function loadOne(id) {
    try {
      const data = await req('GET', `${API}/${id}`);
      const next = normalize(data);
      next.annotations = data.annotations ? data.annotations.map(normalizeNote) : (current() || {}).annotations || [];
      const i = state.items.findIndex((a) => a.id === id);
      if (i >= 0) state.items[i] = next;
      else state.items.unshift(next);
      state.stats = state.stats || null;
      renderAll();
    } catch (err) {
      console.warn('[artifacts] 刷新失败', id, err);
    }
  }

  /* ------------------------------------------------------------ SSE */
  let es = null;
  let wsTimer = null;
  /* 目录树跟成果列表不是同一个接口（树要多扫一遍 ~/.pilotdeck/projects）。
     不能每个事件都重扫 —— 一次返工会连着来好几个事件。用 800ms 尾巴合并，
     树最多每 800ms 刷一次，肉眼看不出差别，磁盘压力降一个数量级。 */
  function refreshWorkspace() {
    if (wsTimer) return;
    wsTimer = setTimeout(async () => {
      wsTimer = null;
      try {
        const ws = await req('GET', `${API}/workspace?limit=400`);
        applyWorkspace(ws);
        renderTree();
      } catch (err) {
        console.warn('[artifacts] 目录刷新失败', err);
      }
    }, 800);
  }

  function connect() {
    setLive('connecting');
    if (es) es.close();
    es = new EventSource(`${API}/events`);
    es.onopen = () => setLive('on');
    es.onerror = () => setLive('off');           // EventSource 自带重连
    const onUpsert = (e) => {
      try {
        const data = JSON.parse(e.data);
        const id = (data.artifact && data.artifact.id) || data.artifact_id;
        if (id) loadOne(id);
      } catch { /* 忽略脏事件 */ }
    };
    const onTree = (e) => { onUpsert(e); refreshWorkspace(); };
    es.addEventListener('artifact.added', onTree);
    es.addEventListener('artifact.ready', onUpsert);
    es.addEventListener('artifact.status', onUpsert);
    es.addEventListener('annotation.added', onUpsert);
    es.addEventListener('annotation.updated', onUpsert);
    es.addEventListener('annotation.deleted', onUpsert);
    es.addEventListener('artifact.dispatched', onUpsert);
  }

  const state = {
    filter: 'all',
    agent: '',
    agents: [],
    agentsOpen: false,
    selectedId: null,
    focus: false,
    /* 左右边栏折叠态，跟 loadSidebars() 从 localStorage 读回来 */
    sideCollapsed: false,
    annoCollapsed: false,
    loading: true,
    items: [],
    /* 目录树：项目 → 会话 → 成果，由 GET /api/artifacts/workspace 给，
       顺序由服务端定（实时会话置顶 + 时间倒序），前端不再重排。 */
    projects: [],
    scope: loadScope(),      // 项目/会话下拉；空串 = 全部；touched = 用户手动选过
    defaultArtifactId: '',
    liveArtifactId: '',
    collapsed: {},          // 折叠态按节点 key 存，重渲染后别弹回去
    filterCollapsed: false, // 正在按类型/来源筛选时，先把树全部展开，省得命中项藏起来
    noteMode: 'point',      // 'point' 点选打点 / 'box' 按住框选 / 'off' 不落标注
    noteArmed: true,        // 标注工具是否在位（置 false 时画面不接标注手势）
    pdfPage: 1,             // 图纸当前页（服务端栅格化，一页一图）
    showHidden: false,      // 展开显示「附属产物 / 显示不出来」的那批
    mvMode: 'view',         // 三维：'view' 旋转 / 'anno' 标注，两种手势互斥
    pan: { k: 1, x: 0, y: 0 },  // 图纸／静态图的缩放与平移
    drafts: [],             // 已落点、还没写说明的标注草稿（只在本地，见 addDraft）
    editingId: null,        // 正在改写说明的已存标注 id
    edit: null,             // { body } 改写中的正文
    editSeverity: 'major',
    activeNoteId: null,
    stats: null,
    loadError: '',
    statsTimer: null,
    mode: 'page',
    chain: [],
    chainOf: '',
    diffBase: '',
    diff: null,
    /* ---- 需求 2：部件树。切部件 = 换一个渲染源，标注锚在部件上 ---- */
    parts: null,            // {root,label,tree,count} 或 null（无部件树）
    partId: '',             // 当前选中的叶子部件 id；'' = 主文件
    /* ---- 需求 4：成果台内就地编辑 ---- */
    editText: false,        // 是否在编辑态
    textBase: '',           // 打开编辑器时的原文（用于判断有没有改动）
    textDirty: false,
    /* ---- 需求 5：应用返工 ---- */
    applying: false,
  };

  /* 标注手势（需求 3）：单击 = 编号，按住拖动 = 框选。
     DRAG_PX 是「动了多远才算拖」的门槛，比 POINT_MAX 小：POINT_MAX 是
     0~1 的归一化比例，这是屏幕像素，两者量纲不同，不能混用。 */
  const DRAG_PX = 6;
  const LONG_PRESS_MS = 520;

  /* ------------------------------------------------------------ 时间 */
  function relTime(iso) {
    const diff = Date.now() - new Date(iso).getTime();
    const m = Math.round(diff / 60e3);
    if (m < 1) return '刚刚';
    if (m < 60) return `${m} 分钟前`;
    const h = Math.round(m / 60);
    if (h < 24) return `${h} 小时前`;
    return `${Math.round(h / 24)} 天前`;
  }
  /* 标注卡上的时间戳用 HH:MM，和控制台既有 clock() 观感一致 */
  function clockOf(iso) {
    return new Date(iso).toLocaleTimeString('zh-CN', { hour12: false });
  }

  /* ------------------------------------------------------------ 左栏 */
  function counts() {
    /* 数目录树全集。之前数 state.items，于是筛选条写「全部 200」而左栏列了 383 行，
       同一个页面两个总数对不上，点筛选还会把明明有的成果筛没。 */
    const all = allArts();
    const out = { all: all.length };
    for (const a of all) out[a.kind] = (out[a.kind] || 0) + 1;
    return out;
  }

  function renderFilters() {
    const c = counts();
    $('artFilters').innerHTML = KINDS.map((k) => {
      if (k.id !== 'all' && !c[k.id]) return '';
      const n = c[k.id] || 0;
      return `<button class="art-chip${state.filter === k.id ? ' active' : ''}" type="button" role="tab"
        aria-selected="${state.filter === k.id}" data-kind="${k.id}">
        <span>${k.icon}</span><span>${k.label}</span><b>${n}</b></button>`;
    }).join('');
    $('sideCount').textContent = String(c.all);
  }

  /* 来源 agent：多 agent 同流（M4）时一眼看出谁交的活，点一下只看它。
     agent 可能有几十个（每台机器一个名），所以默认只露前 3 个，其余折叠起来 ——
     不然筛选条会把成果流整个挤下去屏。 */
  const AGENT_CHIPS_MAX = 3;

  /* 来源分组的计数。以前直接用接口给的 state.agents，那份只统计了列表接口那一页，
     于是标题写「全部 702」、来源却写「全部 383」，同一页两个总数打架。
     改成和类型筛选一样，从目录树全集现算。 */
  function agentCounts() {
    const t = new Map();
    for (const a of allArts()) {
      const k = a.agent || 'pilotdeck';
      t.set(k, (t.get(k) || 0) + 1);
    }
    return [...t.entries()]
      .map(([agent, count]) => ({ agent, count }))
      .sort((x, y) => y.count - x.count);
  }

  function renderAgents() {
    const el = $('artAgents');
    if (!el) return;
    const list = agentCounts();
    if (list.length < 2) { el.innerHTML = ''; return; }
    // 选中的 agent 永远排最前，折叠时也看得见自己在筛选
    const ordered = state.agent
      ? [...list.filter((a) => a.agent === state.agent), ...list.filter((a) => a.agent !== state.agent)]
      : list;
    const open = state.agentsOpen || ordered.length <= AGENT_CHIPS_MAX;
    const shown = open ? ordered : ordered.slice(0, AGENT_CHIPS_MAX);
    const total = list.reduce((n, a) => n + a.count, 0);
    const chip = (name, n, active) =>
      `<button class="art-chip art-chip-agent${active ? ' active' : ''}" type="button"
        data-agent="${esc(name)}" title="${esc(name) || '全部来源'}" aria-pressed="${active}"
        ><span>◈</span><span class="art-chip-name">${esc(name || '全部')}</span><b>${n}</b></button>`;
    el.classList.toggle('open', open && ordered.length > AGENT_CHIPS_MAX);
    el.innerHTML = `<span class="art-agents-label">来源</span>`
      + chip('', total, !state.agent)
      + shown.map((a) => chip(a.agent, a.count, state.agent === a.agent)).join('')
      + (ordered.length > AGENT_CHIPS_MAX
        ? `<button class="art-chip art-chip-more" type="button" data-agents-toggle="1"
             aria-expanded="${open}">${open ? '收起' : `更多 ${ordered.length - AGENT_CHIPS_MAX}`}</button>`
        : '');
  }

  /* 成果按类型筛选，但要作用在整个目录树上 —— 否则筛完只剩一层，用户会以为
     那些项目消失了。所以筛选结果参与「要不要显示这一行」的判断，而不是砍掉整棵树。

     树里的成果字段来自 /workspace（多了 project/session 归属），状态和待处理条数
     以 state.items 为准 —— 那是 SSE 增量刷新过的那份，两边合并一下，
     就不必为了一个状态变化重扫一遍项目目录。 */
  function treeArts(list) {
    const byId = new Map(state.items.map((a) => [a.id, a]));
    return (list || []).map((a) => {
      const merged = { ...a, ...(byId.get(a.id) || {}) };
      /* 只有 /api/artifacts 单条接口才带 annotations；目录树里的条目没这个字段，
         于是 renderOverlay / renderNotesInner 里的 .map/.filter 直接抛 TypeError。
         而那个抛错发生在 select() 里补拉详情之前，详情就永远拉不到 —— 鸡生蛋。
         这里统一兜成空数组。 */
      if (!Array.isArray(merged.annotations)) merged.annotations = [];
      return merged;
    });
  }

  /* 左栏目录树里所有成果的扁平列表（未套筛选），和 state.items 合并过一遍。
     这是「成果」的唯一定义来源。
     以前 current() 只在 state.items 里找，而左栏渲染的是 state.projects（/workspace，
     limit=400），比 state.items（/api/artifacts，limit=200）多出一百多条 ——
     于是点到第 200 条之后的成果时 selectedId 设上了，舞台却回一句
     「从左边选一个成果开始评审」，看起来就是「点了没反应」。 */
  function allArts() {
    const flat = [];
    for (const p of state.projects || []) {
      flat.push(...(p.artifacts || []));                       // 项目直属成果
      for (const s of p.sessions || []) flat.push(...(s.artifacts || []));
    }
    return treeArts(flat);
  }

  function visibleArts(list) {
    return treeArts(list).filter((a) => keepByDefault(a)
                                     && (state.filter === 'all' || a.kind === state.filter)
                                     && (!state.agent || a.agent === state.agent));
  }

  /* ------------------------------------------------------------ 左栏目录树
     树的结构直接对齐 PilotDeck 自己的项目 / 会话目录：项目 → 会话 → 成果。
     服务端已经把「正在实时改的会话」提到每个项目的最前面、其余按时间倒序，
     前端不再二次排序 —— 两边各排一次会打架。 */
  /* ---------------------------------------------------------- 项目/会话下拉
     目标：打开成果台就落在「你正在看的那个对话」上，但绝不用「最近活跃的会话」
     去猜当前对话 —— 同时开着三个对话时它们全是活跃的，猜出来多半不是你想看的那个。
     所以规则是：第一次打开用「活跃 > 最近更新」挑一个当默认值并记住；
     一旦你手动选过，就以你的选择为准，直到你自己改回去。 */
  function loadScope() {
    try {
      const s = JSON.parse(localStorage.getItem(SCOPE_KEY) || '{}');
      return { project: String(s.project || ''), session: String(s.session || ''),
               touched: !!s.touched };
    } catch { return { project: '', session: '', touched: false }; }
  }

  function saveScope() {
    try { localStorage.setItem(SCOPE_KEY, JSON.stringify(state.scope)); } catch { /* 隐私模式 */ }
  }

  function scopeSessions() {
    const out = [];
    for (const p of state.projects || []) {
      if (state.scope.project && p.name !== state.scope.project) continue;
      for (const s of p.sessions || []) out.push({ p, s });
    }
    return out;
  }

  /* 活跃优先；都不活跃就取最近更新的那个。
     只有当这个会话**自己真有成果**时才收窄到会话级 —— 否则退到它所属的项目级。
     为什么：刚开的对话一条成果都还没发，收窄过去只剩一棵空树，用户还以为成果台坏了；
     而停在项目级，「这个对话正在干活」的过程照样看得见（新成果会通过 SSE 自己冒出来）。 */
  function defaultScope() {
    let best = null;
    for (const { p, s } of scopeSessions()) {
      if (s.live) { best = { p, s }; break; }
      const t = Date.parse(s.updated_at || s.last_modified || '') || 0;
      if (!best || t > best.t) best = { p, s, t };
    }
    if (!best) return { project: '', session: '', touched: false };
    const has = (best.s.artifacts || []).length || (best.p.artifacts || []).length;
    return { project: best.p.name, session: has ? best.s.id : '', touched: false };
  }

  function renderScope() {
    const sp = $('selProject'); const ss = $('selSession');
    if (!sp || !ss) return;
    const projects = (state.projects || []).filter(
      (p) => (p.sessions || []).length || (p.artifacts || []).length);

    sp.innerHTML = '<option value="">全部项目</option>'
      + projects.map((p) => `<option value="${esc(p.name)}">${esc(p.name)}</option>`).join('');
    sp.value = state.scope.project || '';

    const sess = scopeSessions();
    /* 会话按「活跃在前 + 时间倒序」排；服务端已经这么排过一遍，
       这里只把下拉的默认项摆到最前，不重排内容，避免跟左栏树打架。 */
    const rows = sess.slice().sort((a, b) => {
      const la = a.s.live ? 1 : 0; const lb = b.s.live ? 1 : 0;
      if (la !== lb) return lb - la;
      return (Date.parse(b.s.updated_at || '') || 0) - (Date.parse(a.s.updated_at || '') || 0);
    });
    ss.innerHTML = '<option value="">全部会话</option>'
      + rows.map(({ p, s }) => `<option value="${esc(s.id)}">`
        + `${esc(p.name)} · ${esc(s.title || s.id)}</option>`).join('');
    ss.value = state.scope.session || '';

    sp.onchange = () => {
      state.scope.project = sp.value;
      state.scope.session = '';       // 换了项目，旧会话多半不在新项目里
      state.scope.touched = true;
      saveScope(); renderScope(); renderTree(); syncSelectionToScope();
    };
    ss.onchange = () => {
      const hit = sess.find((r) => r.s.id === ss.value);
      state.scope.session = ss.value;
      if (hit) state.scope.project = hit.p.name;
      state.scope.touched = true;
      saveScope(); renderScope(); renderTree(); syncSelectionToScope();
    };
  }

  function inScopeProject(p) { return !state.scope.project || p.name === state.scope.project; }
  function inScopeSession(s) { return !state.scope.session || s.id === state.scope.session; }

  /* 当前范围里、且和左栏用同一套过滤规则后会真正列出来的成果，顺序与左栏一致。 */
  function scopeArts() {
    const out = [];
    (state.projects || []).forEach((p) => {
      if (!inScopeProject(p)) return;
      (p.sessions || []).filter(inScopeSession).forEach((s) => {
        visibleArts(s.artifacts || []).forEach((a) => out.push(a));
      });
      if (!state.scope.session) visibleArts(p.artifacts || []).forEach((a) => out.push(a));
    });
    return out;
  }

  /* 切会话后必须真的换内容。
     以前两个 onchange 只做 saveScope/renderScope/renderTree —— 左栏换了会话，
     中间的舞台却还停在上一条成果上（state.selectedId 根本没被碰过），
     看着就像「下拉选了没用」。这里把选中项对齐到新范围：还在就留着，
     不在就自动选中该范围的第一条；一个都没有就清空舞台，别留上一会话的东西。 */
  function syncSelectionToScope() {
    const arts = scopeArts();
    if (state.selectedId && arts.some((a) => a.id === state.selectedId)) return;
    const first = arts.length ? (foldVersions(arts)[0] || {}).head : null;
    if (first && first.id) { select(first.id); return; }
    if (state.selectedId) {
      state.selectedId = null;
      state.chain = []; state.chainOf = ''; state.diff = null;
      state.activeNoteId = null; state.drafts = []; state.editingId = null;
      state.edit = null; state.partId = ''; state.parts = null;
      renderStage();
    }
  }

  function renderTree() {
    bindHiddenToggle();
    const chk = $('chkShowHidden');
    if (chk && chk.checked !== state.showHidden) chk.checked = state.showHidden;
    const el = $('artTree');
    if (!el) return;
    if (state.loading) {
      el.innerHTML = Array.from({ length: 4 }, () => '<div class="art-skel art-skel-row"></div>').join('');
      return;
    }
    if (state.loadError) {
      el.innerHTML = `<div class="art-hint"><span class="glyph">⚠</span>
        <span>目录加载失败</span><span class="mono">${esc(state.loadError)}</span></div>`;
      return;
    }

    const projects = state.projects || [];
    const blocks = [];
    let shownArts = 0;

    projects.forEach((p) => {
      if (!inScopeProject(p)) return;
      const sessions = (p.sessions || []).filter(inScopeSession).map((s) => {
        const arts = visibleArts(s.artifacts);
        return { s, arts, count: (s.artifacts || []).length };
      }).filter((row) => row.arts.length || !state.filterCollapsed);

      /* 整棵树都没有符合当前筛选的成果时，这个项目不占地方。
         项目直属成果（不属于任何会话的）以前在会话级筛选下**照常显示**，
         理由是「按会话筛掉就等于成果凭空消失」。实测这条理由站不住：
         用户选了会话还在左栏看到几百条不属于这个会话的成果，正是「选择会话后
         仍然显示很多内容」的来源 —— 那些成果本来就不属于任何一个会话。
         现在改成：选了会话就只列这个会话的；想看它们把下拉切回「全部会话」，
         入口一直在，不会真的丢。 */
      const ownArts = state.scope.session ? [] : visibleArts(p.artifacts);
      if (!sessions.length && !ownArts.length) return;
      const collapsed = state.collapsed[p.name] && !state.filterCollapsed;
      const pLive = !!p.live;
      /* 项目徽标要跟底下真正列出来的行对上：直属成果 + 各会话成果。
         以前只算 p.artifacts，于是徽标写 252、底下却列出 383 行（反过来也发生过）。 */
      const total = ownArts.length
        + sessions.reduce((n, r) => n + r.arts.length, 0);

      const sessionRows = sessions.map(({ s, arts, count }) => {
        if (!arts.length) {
          return `<div class="art-node art-node-session art-node-empty">
            <span class="art-node-name">${esc(s.title)}</span>
            <span class="art-node-meta">${s.live ? '<em class="art-live-dot">实时</em>' : ''}
              ${esc(clockOf(s.updated_at))} · 无成果</span></div>`;
        }
        const sCollapsed = state.collapsed['s:' + s.id];
        return `<div class="art-node art-node-session${s.live ? ' live' : ''}">
          <button class="art-node-head" type="button" data-toggle-session="${esc(s.id)}"
                  aria-expanded="${!sCollapsed}" title="${esc(s.cwd || s.id)}">
            <span class="art-caret">${sCollapsed ? '▸' : '▾'}</span>
            <span class="art-node-name">${esc(s.title)}</span>
            ${s.live ? '<em class="art-live-dot">实时</em>' : ''}
            <span class="art-node-count">${arts.length}</span>
          </button>
          <div class="art-node-body"${sCollapsed ? ' hidden' : ''}>
            ${foldVersions(arts).map(({ head, root, older }) => {
              shownArts++;
              /* 需求 1：默认只留最终版。!undefined 是 true —— 以前这里等于
                 「默认展开旧版本」，结果每条成果链在左栏摊开一长串历史版，
                 跟「只显示最终成果」正好相反。 */
              const vOpen = state.collapsed['v:' + root] === true;
              return artNode(head, older.length
                ? `<span class="art-ver-more" data-toggle-vers="${esc(root)}"
                       title="展开这条成果链的 ${older.length} 个旧版本（含同名重复发布）">×${older.length + 1}</span>`
                : '') + (older.length
                  ? `<div class="art-node-body art-ver-old"${vOpen ? '' : ' hidden'}>
                       ${older.map((o) => { shownArts++; return artNode(o); }).join('')}
                     </div>`
                  : '');
            }).join('')}
            ${count > arts.length ? `<div class="art-node-more">还有 ${count - arts.length} 条被筛选掉了</div>` : ''}
          </div>
        </div>`;
      }).join('');

      /* 项目直属成果（不属于任何会话）。
         以前这里只渲染 sessionRows，p.artifacts 被算进徽标却一行都不画 ——
         实测 9 个项目里 319 条成果既看不见也点不着（702 条只列出 383 条）。 */
      const ownRows = ownArts.length
        ? `<div class="art-node art-node-session art-node-own">
             <div class="art-node-name">项目直属成果 <span class="art-node-count">${ownArts.length}</span></div>
             <div class="art-node-body">${ownArts.map((a) => { shownArts++; return artNode(a); }).join('')}</div>           </div>`
        : '';

      blocks.push(`<div class="art-project${pLive ? ' live' : ''}${collapsed ? ' collapsed' : ''}">
        <button class="art-project-head" type="button" data-toggle-project="${esc(p.name)}"
                aria-expanded="${!collapsed}" title="${esc(p.fullPath || p.name)}">
          <span class="art-caret">${collapsed ? '▸' : '▾'}</span>
          <span class="art-node-name">${esc(p.displayName)}</span>
          ${pLive ? '<em class="art-live-dot">实时</em>' : ''}
          <span class="art-node-count">${total}</span>
        </button>
        <div class="art-project-body"${collapsed ? ' hidden' : ''}>
          <div class="art-project-path">${esc(p.fullPath || '')}</div>
          ${ownRows}
          ${sessionRows || (ownArts.length ? '' : `<div class="art-node art-node-empty">该项目下暂无成果</div>`)}
        </div>
      </div>`);
    });

    if (!blocks.length) {
      el.innerHTML = `<div class="art-hint"><span class="glyph">◌</span>
        <span>${state.filter === 'all' ? '还没有成果，agent 发布后会出现在这里' : '该类型下还没有成果'}</span></div>`;
      return;
    }
    el.innerHTML = blocks.join('');
    $('sideCount').textContent = String(shownArts);
  }

  function artNode(a, extra) {
    const seqs = a.open_notes
      ? `<span class="art-seq-mini" title="${a.open_notes} 条待处理意见">${a.open_notes}</span>` : '';
    /* 来源标签：以前卡片流上每一张都挂着，切到目录树以后没跟着搬过来 ——
       代价是「全部」视图下根本看不出这堆成果分别是谁交的，
       而按 agent 筛选恰恰就是为多 agent 混排准备的。 */
    const src = a.agent
      ? `<span class="art-src-agent" title="来源：${esc(a.agent)}">◈ ${esc(a.agent)}</span>`
      : '';
    return `<div class="art-node art-node-artifact${a.id === state.selectedId ? ' selected' : ''}"
                 role="treeitem" tabindex="0" data-id="${esc(a.id)}" title="${esc(a.title)}">
      <span class="art-node-icon">${KIND_ICON[a.kind] || '▧'}</span>
      <span class="art-node-name">${esc(a.title)}</span>
      ${src}
      ${seqs}
      <span class="art-status" data-status="${esc(a.status)}"></span>
      ${extra || ''}
    </div>`;
  }

  /* ------------------------------------------------------------ 版本折叠（需求 1）
     同一条成果链只留最新版，旧版收在一行里 —— 评审要判断的是「现在这版对不对」，
     把 v1/v2/v3 摊平了等于让人先考古。折叠不影响选中：展开后可逐版点。 */
  function bindHiddenToggle() {
    const chk = $('chkShowHidden');
    if (!chk || chk.dataset.bound) return;
    chk.dataset.bound = '1';
    chk.addEventListener('change', () => {
      state.showHidden = chk.checked;
      renderTree();
    });
  }

  function foldVersions(list) {
    const byId = new Map(list.map((a) => [a.id, a]));
    const rootOf = (a) => {
      let cur = a;
      const seen = new Set([cur.id]);
      while (cur.parent_id && byId.has(cur.parent_id) && !seen.has(cur.parent_id)) {
        seen.add(cur.parent_id);
        cur = byId.get(cur.parent_id);
      }
      return cur.id;
    };
    /* 第二层折叠：同一个文件被反复发布时，parent_id 往往是空的
       （真实实例上 shot.png 112 条里只有 12 条有 parent_id），于是折不动，
       735 条其实只有 30 组不同的文件，列表就被灌成了一堵墙。
       服务端按 (项目, 文件名, 大小) 给了 dup_key，先跑一遍 parent_id 链，
       再按 dup_key 把这些「没串起来」的同源记录并进同一条链。
       并进去的记 dup_count，显示成「×N」，历史一条都不删。 */
    const dupToRoot = new Map();
    list.forEach((a) => {
      const k = a.dup_key;
      if (k && !dupToRoot.has(k)) dupToRoot.set(k, rootOf(a));
    });
    const rootKey = (a) => {
      const chain = rootOf(a);
      const k = a.dup_key;
      if (k && dupToRoot.has(k)) return dupToRoot.get(k);
      return chain;
    };

    /* 服务端已按时间倒序，所以第一次遇到的必然是这条链的最新版 */
    const heads = [];
    const older = new Map();
    list.forEach((a) => {
      const k = rootKey(a);
      if (!older.has(k)) { older.set(k, []); heads.push({ head: a, root: k, older: older.get(k) }); }
      if (a.id !== a.id) return;
      if (a.id !== k) older.get(k).push(a);
    });
    heads.forEach((h) => {
      h.dupes = h.older.length;
      h.older.sort((x, y) => String(y.ts || '').localeCompare(String(x.ts || '')));
    });
    return heads;
  }

  /* 默认只露出「能给人看的正式成果」：
     - displayable=false（空文件名 / 0 字节 / 文件已不在）默认藏起来，
     - deliverable=aux（元素截图、图标、页面引用的资源）默认藏起来。
     两类都还能通过「显示隐藏项」翻出来 —— 只是不再占默认视野。 */
  function keepByDefault(a) {
    if (state.showHidden) return true;
    if (a.displayable === false) return false;
    if (a.deliverable === 'aux') return false;
    return true;
  }

  /* ------------------------------------------------------------ 舞台 */
  function current() {
    /* 在目录树全集里找，不要只看 state.items：树有 383 行，items 只有 200 条 */
    return allArts().find((a) => a.id === state.selectedId) || null;
  }

  /* 文本类文档：<object> 只认插件类型，纯文本会渲染成空白，
     所以自己把 raw 抓回来铺成可滚动的 <pre>。 */
  function hydrateTextStage(root) {
    const pre = root.querySelector('pre.art-text[data-src]');
    if (!pre) return;
    const src = pre.getAttribute('data-src');
    pre.removeAttribute('data-src');
    fetch(src, { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((text) => { pre.textContent = text; })
      .catch((err) => { pre.textContent = `文本读不出来：${err.message}`; });
  }

  /* 图纸／静态图：浏览模式下支持滚轮缩放和拖动平移。
   标注在位时手势交给标注层，这里不抢 —— 两套手势不能同时生效。 */
  function attachPanZoom(inner) {
    const target = inner.querySelector('.art-render > img, .art-render > svg');
    if (!target) return;
    const apply = () => {
      const { k, x, y } = state.pan;
      target.style.transform = (k === 1 && !x && !y) ? '' : `translate(${x}px, ${y}px) scale(${k})`;
      target.style.transformOrigin = 'center center';
      target.style.willChange = 'transform';
    };
    let dragging = null;
    inner.addEventListener('wheel', (ev) => {
      if (noteArmed()) return;
      ev.preventDefault();
      const next = state.pan.k * (ev.deltaY < 0 ? 1.12 : 0.89);
      state.pan.k = Math.min(8, Math.max(0.2, next));
      apply();
    }, { passive: false });
    inner.addEventListener('pointerdown', (ev) => {
      if (noteArmed() || ev.button > 0) return;
      dragging = { x: ev.clientX, y: ev.clientY, ox: state.pan.x, oy: state.pan.y };
      inner.setPointerCapture(ev.pointerId);
    });
    inner.addEventListener('pointermove', (ev) => {
      if (!dragging) return;
      state.pan.x = dragging.ox + (ev.clientX - dragging.x);
      state.pan.y = dragging.oy + (ev.clientY - dragging.y);
      apply();
    });
    const stop = () => { dragging = null; };
    inner.addEventListener('pointerup', stop);
    inner.addEventListener('pointercancel', stop);
    inner.addEventListener('dblclick', () => {
      if (noteArmed()) return;
      state.pan = { k: 1, x: 0, y: 0 };
      apply();
    });
  }

  function renderStage() {
    const stage = $('stage');
    const a = current();
    defaultGestureMode(a);

    // 工具条
    $('stageTitle').textContent = a ? a.title : '未选择成果';
    const ver = $('stageVer');
    ver.hidden = !a;
    if (a) ver.textContent = `v${a.version} · ${KIND_LABEL[a.kind]}`;
    $('stageModes').hidden = !a || a.kind !== 'page';
    $('btnDownload').hidden = !a;
    $('btnApprove').hidden = !a;
    $('btnReject').hidden = !a;
    $('btnFocus').hidden = !a;
    /* 「编辑」只在成果台自己能读写的文本类成果上出现：
       要改的是审的这一版，不是原项目里的文件。 */
    const editable = !!(a && isEditableText(a));
    const btnEdit = $('btnEdit');
    if (btnEdit) {
      btnEdit.hidden = !editable;
      btnEdit.textContent = state.editText ? '▣ 预览' : '✎ 编辑';
      btnEdit.classList.toggle('active', state.editText);
    }

    if (state.loadError && !allArts().length) {
      stage.innerHTML = `<div class="art-hint error">
        <span class="glyph">⚠</span><span>成果台接口没连上</span>
        <span class="mono">${esc(state.loadError)}</span>
        <button class="ghost-btn" type="button" onclick="location.reload()">重试</button></div>`;
      return;
    }
    if (!a) {
      stage.innerHTML = `<div class="art-hint" id="stageEmpty">
        <span class="glyph">▣</span><span>从左边选一个成果开始评审</span></div>`;
      return;
    }

    const rail = renderPartRail(a);
    const inner = document.createElement('div');
    inner.className = 'art-stage-inner';
    inner.innerHTML = renderMedia(a);

    const overlay = document.createElement('div');
    overlay.className = 'art-overlay';
    overlay.id = 'overlay';
    inner.appendChild(overlay);
    hydrateTextStage(inner);
    if (state.panArtifact !== (a && a.id)) {
      state.panArtifact = a && a.id;
      state.pan = { k: 1, x: 0, y: 0 };
    }
    attachPanZoom(inner);

    stage.innerHTML = '';
    if (rail) stage.appendChild(rail);
    stage.appendChild(inner);

    if (state.editText) mountTextEditor(inner, a);
    buildTransport(a, inner);
    /* 栅格页加载失败（PDF 损坏 / pdftoppm 没装）时退回浏览器自带阅读器：
       宁可给一个可能全黑的 <embed>，也不要只留一个裂图 —— 用户至少还能
       看到文件确实在。 */
    inner.querySelectorAll('img[data-pdf-page]').forEach((imgEl) => {
      imgEl.addEventListener('error', () => {
        if (!imgEl.isConnected) return;
        const raw = imgEl.dataset.rawSrc;
        if (!raw) {
          imgEl.insertAdjacentHTML('afterend',
            `<div class="art-hint error"><span class="glyph">⚠</span>
             <span>这份图纸打不开</span></div>`);
          return;
        }
        imgEl.insertAdjacentHTML('afterend',
          `<div class="art-render art-pdf-fallback">
             <embed class="art-doc" type="application/pdf" src="${esc(raw)}"></div>`);
        imgEl.remove();
      }, { once: true });
    });

    if (inner.querySelector('model-viewer')) {
      applyMvMode();
      inner.querySelectorAll('[data-mv-mode]').forEach((b) => {
        b.addEventListener('click', (ev) => {
          ev.stopPropagation();
          state.mvMode = b.dataset.mvMode;
          renderStage();
        });
      });
    }

    /* 气泡挂两遍：先按当前盒子画一版（数据到了就画，别等图），
       图 load 后再按真实尺寸重画一次定位。img 裂了也不会永远空着。 */
    const img = inner.querySelector('img');
    const paint = () => requestAnimationFrame(() => renderOverlay());
    if (img) {
      img.addEventListener('load', paint, { once: true });
      img.addEventListener('error', () => {
        if (state.editText) return;              // 编辑态里没有 img，别把编辑器擦了
        stage.innerHTML = `<div class="art-hint error">
          <span class="glyph">⚠</span><span>这份成果预览不出来</span>
          <button class="ghost-btn" type="button" onclick="location.reload()">重试</button></div>`;
      }, { once: true });
    }
    if (inner.querySelector('model-viewer')) {
      /* 三维模型是自绘的，尺寸要等它 load 完才知道，标注框跟着它重算 */
      const mv = inner.querySelector('model-viewer');
      mv.addEventListener('load', paint, { once: true });
      mv.addEventListener('error', (ev) => {
        /* 「渲染器没起来」和「这个模型文件解析不了」是两回事，用户给的
           截图里混成一句「三维模型加载失败」，看不出该找谁修。这里分开说：
           渲染器失败 → 环境问题；文件解析失败 → 让作者重发一份 glb。 */
        const detail = mv.getAttribute('data-mv-error') || '';
        const rendererGone = !!window.modelViewerError;
        const why = rendererGone
          ? '三维渲染器没能加载（成果台依赖的 model-viewer 模块没起来），这是成果台侧的问题'
          : (detail || '这个文件不是有效的 glb/gltf，或内容已被截断；请重新导出一份再发布');
        mv.insertAdjacentHTML('afterend',
          `<div class="art-hint error"><span class="glyph">⚠</span>
           <span>${rendererGone ? '三维渲染器加载失败' : '三维模型文件解析失败'}</span>
           <span class="mono">${esc(why)}</span>
           ${partHint(a) ? `<span class="mono">${esc(partHint(a))}</span>` : ''}
           <a class="ghost-btn" href="${esc(mv.getAttribute('src') || '#')}"
             target="_blank" rel="noopener">下载原文件看看</a></div>`);
      }, { once: true });
    }
    paint();
  }

  /* ------------------------------------------------------------ 画面控制条
     放在 .art-stage-inner 里、但和标注层分家：CSS 把标注层的下边距让出来，
     所以控制条永远在标注层之上，点得到；标注坐标也不会错位。 */
  function videoTimeAt() {
    const a = current();
    if (!a || a.kind !== 'video') return null;
    const v = document.querySelector('.art-stage-inner video');
    if (!v) return null;
    return Number.isFinite(v.currentTime) ? v.currentTime : null;
  }

  function needsTransport(a) {
    return a && (a.kind === 'video' || isPdfView(a));
  }

  function buildTransport(a, inner) {
    if (!needsTransport(a)) { inner.classList.remove('has-transport'); return; }
    inner.classList.add('has-transport');
    const bar = document.createElement('div');
    bar.className = 'art-transport';
    if (a.kind === 'video') buildVideoTransport(a, bar, inner);
    else buildPdfTransport(a, bar, inner);
    inner.appendChild(bar);
  }

  function buildVideoTransport(a, bar, inner) {
    const v = inner.querySelector('video');
    if (!v) { inner.classList.remove('has-transport'); return; }
    const fps = videoFps(a);
    const dur = parseFloat(videoMeta(a).duration) || v.duration || 0;
    bar.innerHTML = `
      <button class="art-tbtn" type="button" data-act="play" title="播放 / 暂停">▶</button>
      <button class="art-tbtn" type="button" data-act="stop" title="停止并回到开头">■</button>
      <div class="art-trail"><input class="art-seek" type="range" min="0" max="1000" value="0"
        aria-label="播放进度"></div>
      <span class="art-tlabel"><b data-t="now">0:00</b> / <span data-t="dur">${esc(fmtTime(dur))}</span></span>
      ${fps ? `<span class="art-tlabel" data-t="frame" title="帧率 ${fps} fps">第 0 帧</span>` : ''}`;

    const seek = bar.querySelector('.art-seek');
    const nowEl = bar.querySelector('[data-t="now"]');
    const durEl = bar.querySelector('[data-t="dur"]');
    const frameEl = bar.querySelector('[data-t="frame"]');
    const playBtn = bar.querySelector('[data-act="play"]');
    const stopBtn = bar.querySelector('[data-act="stop"]');

    const total = () => (Number.isFinite(v.duration) && v.duration > 0 ? v.duration : dur);
    const sync = () => {
      const d = total();
      const cur = v.currentTime || 0;
      if (d > 0) seek.value = String(Math.round((cur / d) * 1000));
      nowEl.textContent = fmtTime(cur);
      if (frameEl) frameEl.textContent = `第 ${Math.round(cur * fps)} 帧`;
      playBtn.textContent = v.paused ? '▶' : '❚❚';
      paintVideoMarks(a, inner, v);
    };
    v.addEventListener('timeupdate', sync);
    v.addEventListener('loadedmetadata', sync);
    v.addEventListener('play', sync);
    v.addEventListener('pause', sync);
    v.addEventListener('seeked', sync);
    v.addEventListener('ended', sync);

    const stop = (ev) => { ev.stopPropagation(); v.pause(); v.currentTime = 0; sync(); };
    playBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      if (v.paused) v.play().catch(() => {}); else v.pause();
      sync();
    });
    stopBtn.addEventListener('click', stop);
    seek.addEventListener('pointerdown', (ev) => ev.stopPropagation());
    seek.addEventListener('input', () => {
      const d = total();
      if (d > 0) v.currentTime = (Number(seek.value) / 1000) * d;
      sync();
    });
    sync();
  }

  /* 时间轴上的标注点：点一下跳到那一刻。 */
  function paintVideoMarks(a, inner, v) {
    const bar = inner.querySelector('.art-transport');
    if (!bar) return;
    let trail = bar.querySelector('.art-trail');
    if (!trail) return;
    let marks = trail.querySelector('.art-vmarks');
    if (!marks) {
      marks = document.createElement('div');
      marks.className = 'art-vmarks';
      marks.style.cssText = 'position:absolute;left:0;right:0;top:50%;height:0;pointer-events:none;';
      trail.appendChild(marks);
    }
    const d = Number.isFinite(v.duration) && v.duration > 0 ? v.duration : 0;
    const pts = [];
    (a.annotations || []).forEach((n) => {
      const t = n.anchor && n.anchor.t;
      if (Number.isFinite(t)) pts.push({ id: n.id, t });
    });
    state.drafts.forEach((dft) => {
      const t = dft.anchor && dft.anchor.t;
      if (Number.isFinite(t)) pts.push({ id: dft.key, t, draft: true });
    });
    marks.innerHTML = pts.map((p) =>
      `<span class="art-vmark" data-note="${esc(p.id)}" data-draft="${p.draft ? '1' : '0'}"
        data-active="false" title="${esc(fmtTime(p.t))}"
        style="left:${d > 0 ? Math.min(100, (p.t / d) * 100) : 0}%"></span>`).join('');
    marks.querySelectorAll('.art-vmark').forEach((el) => {
      el.addEventListener('pointerdown', (ev) => ev.stopPropagation());
      el.addEventListener('click', (ev) => {
        ev.stopPropagation();
        const id = el.dataset.note;
        if (el.dataset.draft === '1') {
          state.activeNoteId = id;
          renderNotes();
        } else {
          focusNote(id, { pulse: true });
        }
      });
    });
  }

  function seekToNote(noteId) {
    const a = current();
    if (!a || a.kind !== 'video') return false;
    const n = (a.annotations || []).find((x) => x.id === noteId);
    const t = n && n.anchor && n.anchor.t;
    const v = document.querySelector('.art-stage-inner video');
    if (!Number.isFinite(t) || !v) return false;
    v.currentTime = t;
    v.pause();
    return true;
  }

  function buildPdfTransport(a, bar, inner) {
    const part = partOf(a);
    const pages = pdfPageCount(a);
    if (pages <= 1) { inner.classList.remove('has-transport'); return; }
    let page = Math.min(pages, Math.max(1, state.pdfPage || 1));
    state.pdfPage = page;
    bar.innerHTML = `
      <span class="art-tlabel">图纸页</span>
      <div class="art-tpage">
        <button class="art-tbtn" type="button" data-act="prev" title="上一页">‹</button>
        <span class="art-tlabel"><b data-t="page">${page}</b> / ${pages}</span>
        <button class="art-tbtn" type="button" data-act="next" title="下一页">›</button>
      </div>`;
    const img = inner.querySelector('img[data-pdf-page]');
    const show = (n) => {
      page = Math.min(pages, Math.max(1, n));
      state.pdfPage = page;
      bar.querySelector('[data-t="page"]').textContent = String(page);
      if (img) img.src = part ? pdfPartSrc(a, part, page) : pdfPageSrc(a, page);
      renderOverlay();
    };
    bar.querySelector('[data-act="prev"]').addEventListener('click',
      (ev) => { ev.stopPropagation(); show(page - 1); });
    bar.querySelector('[data-act="next"]').addEventListener('click',
      (ev) => { ev.stopPropagation(); show(page + 1); });
    bar.addEventListener('pointerdown', (ev) => ev.stopPropagation());
  }

  /* ------------------------------------------------------------ 部件树（需求 2）
     图纸/三维如果由多个独立部件组成，发布方在主文件旁放 `<名>.parts.json`。
     这里把它渲染成一条竖排的树，选中哪个部件就只渲染那个部件，
     标注锚点带 part id —— 切来切去意见不会串。 */
  function renderPartRail(a) {
    const parts = state.parts && state.parts.artifact === a.id ? state.parts.data : a.parts;
    if (!parts || !parts.tree || !parts.tree.length) return null;
    const rows = [];
    const walk = (nodes) => {
      nodes.forEach((n) => {
        const on = (state.partId || '') === n.id;
        rows.push(`<button type="button" class="art-part${on ? ' active' : ''}"
          data-part="${esc(n.id)}" style="--d:${n.depth || 0}"
          title="${esc(n.label || n.id)}${n.missing ? '（文件缺失）' : ''}">
          <span class="art-part-dot"></span><span class="art-part-name">${esc(n.label || n.id)}</span>
          ${n.missing ? '<span class="art-part-warn">缺</span>' : ''}</button>`);
        if (n.children) walk(n.children);
      });
    };
    walk(parts.tree);
    const el = document.createElement('nav');
    el.className = 'art-parts';
    el.id = 'partTree';
    el.innerHTML = `<div class="art-parts-head">${esc(parts.label || '部件')}
        <span>${parts.count || rows.length} 个</span></div>
      <div class="art-parts-list">${rows.join('')}</div>`;
    return el;
  }

  function partOf(a) {
    const parts = state.parts && state.parts.artifact === a.id ? state.parts.data : a.parts;
    if (!parts || !state.partId) return null;
    let hit = null;
    const walk = (nodes) => nodes.forEach((n) => {
      if (n.id === state.partId) hit = n;
      if (n.children) walk(n.children);
    });
    walk(parts.tree || []);
    return hit;
  }

  function partHint(a) {
    const n = partOf(a);
    if (!n) return '';
    return n.missing ? `部件 ${n.label} 的文件没进来` : '';
  }

  async function selectPart(id) {
    state.partId = id || '';
    state.drafts = [];                 // 换图了，别把上一个部件的草稿带过去
    renderStage();
    renderNotes();
  }

  async function loadParts(a) {
    if (!a) { state.parts = null; return; }
    if (a.kind !== 'drawing' && a.kind !== 'model3d') { state.parts = null; return; }
    try {
      const r = await req('GET', `${API}/${a.id}/parts`);
      state.parts = { artifact: a.id, data: r.parts || null };
    } catch {
      state.parts = { artifact: a.id, data: null };
    }
  }

  const MODEL_EXT = ['glb', 'gltf', 'obj', 'stl', 'ply', '3ds', 'dae', '3mf'];
  const TEXT_EXT = ['html', 'htm', 'md', 'markdown', 'txt', 'svg', 'json', 'css', 'js'];

  function extOf(a) {
    const u = (a && (a.source_path || a.src)) || '';
    const m = String(u).toLowerCase().match(/\.([a-z0-9]+)(?:[?#].*)?$/);
    return m ? m[1] : '';
  }

  function isEditableText(a) {
    const mime = (a.mime || '').toLowerCase();
    if (mime.startsWith('text/') && !mime.includes('pdf')) return true;
    if (mime.includes('markdown') || mime.includes('json') || mime.includes('xml')) return true;
    return TEXT_EXT.includes(extOf(a));
  }

  /* ---------------------------------------------------------- 图纸栅格图源 */
  /* 服务端把 PDF 第 n 页栅格化成 PNG（GET /api/artifacts/<id>/pages/<n>）。
     没有这一步就只能用 <embed> 塞 PDF，缺插件的浏览器上是一块黑框。 */
  function pdfPageSrc(a, page) {
    return `${API}/${a.id}/pages/${page || 1}`;
  }

  function pdfPartSrc(a, part, page) {
    const name = encodeURIComponent(part.stored || part.url.split('/').pop() || '');
    return `${API}/${a.id}/part-pages/${name}/${page || 1}`;
  }

  function pdfPageCount(a) {
    const meta = (a && a.meta) || {};
    const n = parseInt(meta.pages || 0, 10);
    return Number.isFinite(n) && n > 0 ? n : 1;
  }

  function isPdfView(a) {
    const part = partOf(a);
    if (part) return /\.pdf$/i.test(part.path || '');
    if (!a || a.kind !== 'drawing') return false;
    return /\.pdf$/i.test(a.source_path || '') || /pdf/.test(a.mime || '');
  }

  function videoMeta(a) {
    return (a && a.meta) || {};
  }

  function videoFps(a) {
    const fps = parseFloat(videoMeta(a).fps);
    return Number.isFinite(fps) && fps > 0 ? fps : 0;
  }

  function fmtTime(sec) {
    if (!Number.isFinite(sec) || sec < 0) sec = 0;
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  function renderMedia(a) {
    /* page 有两种看法：页面模式看服务端快照（所见即所标注，跟标注坐标严格对齐），
       真机预览走 iframe 打 dev server（能点能滚，但跨源，标注只落在快照上）。
       切换时清掉 overlay，避免两个坐标系混画。 */
    const bust = a.src ? `${a.src}${a.src.includes('?') ? '&' : '?'}_=${a.updated_at || ''}` : '';
    /* 快照图是给 img 的位图/SVG，a.src 是原始文件。
       page 的 a.src 是 HTML 源文件，塞进 <img> 必裂图 —— 拿快照图，没有快照才退回 iframe 看源文件。 */
    const snap = a.thumb
      ? `${a.thumb}${a.thumb.includes('?') ? '&' : '?'}_=${a.updated_at || ''}` : '';
    /* 选中部件时渲染的是部件，不是主文件 —— 这就是「部件可独立显示」的落点 */
    const part = partOf(a);
    const partSrc = part ? part.url : '';
    const ext = (part ? (part.kind === 'drawing' ? 'pdf' : part.path || '') : '').toLowerCase();

    if (state.editText && isEditableText(a)) return renderTextEditor(a);

    if (part) {
      if (part.missing) {
        return `<div class="art-hint error"><span class="glyph">⚠</span>
          <span>部件「${esc(part.label)}」的文件没进来</span>
          <span class="mono">${esc(part.path || '')}</span></div>`;
      }
      if (MODEL_EXT.includes(extOf({ source_path: part.path })) || part.kind === 'model3d') {
        return renderModel(partSrc, a, part);
      }
      if (/\.pdf$/i.test(part.path || '')) {
        /* PDF 部件走服务端栅格图。<embed>/<object> 放 PDF 在没有内置 PDF
           插件的浏览器上就是一块黑框（用户报「图纸选中了是黑矩形」）。 */
        return `<div class="art-render"><img src="${esc(pdfPartSrc(a, part, state.pdfPage || 1))}"
          data-raw-src="${esc(partSrc)}"
          alt="${esc(part.label)} 第 ${state.pdfPage || 1} 页" data-pdf-page="${state.pdfPage || 1}"></div>`;
      }
      return `<div class="art-render"><img src="${esc(partSrc)}" alt="${esc(part.label)}"></div>`;
    }

    switch (a.kind) {
      case 'page':
        /* 真机预览优先用真地址；没有真地址时退回原页面本身，
           否则点「真机预览」看到的还是同一张快照，等于没得切。 */
        if (state.mode === 'live' && (a.live || a.kind === 'page')) {
          return `<div class="art-render"><iframe title="${esc(a.title)}" sandbox="allow-scripts allow-same-origin"
            src="${esc(a.live || bust)}"></iframe></div>`;
        }
        if (snap) return `<div class="art-render"><img src="${esc(snap)}" alt="${esc(a.title)}"></div>`;
        return `<div class="art-render"><iframe title="${esc(a.title)}" sandbox="allow-scripts allow-same-origin"
          src="${esc(bust)}"></iframe></div>`;
      case 'video':
        /* controls 关掉：原生控件整个压在 .art-overlay.armed 底下，标注一开
           播放/暂停/进度条一个都点不动。改用画面下方的 art-transport。 */
        return `<div class="art-render"><video preload="metadata"
            src="${esc(bust)}"></video></div>`;
      case 'model3d':
        return renderModel(bust, a, null);
      case 'drawing': {
        /* 图纸出图以 PDF/SVG 为主（需求 2）：
           PDF 走浏览器自带阅读器，SVG 是矢量图直接 img —— 两者都是真显示，
           不再退化成一张看不清的缩略图。 */
        if (/\.pdf$/i.test(a.source_path || '') || /pdf/.test(a.mime || '')) {
          return `<div class="art-render"><img src="${esc(pdfPageSrc(a, state.pdfPage || 1))}"
            data-raw-src="${esc(bust)}"
            alt="${esc(a.title)} 第 ${state.pdfPage || 1} 页" data-pdf-page="${state.pdfPage || 1}"></div>`;
        }
        if (/\.svg$/i.test(a.source_path || a.src || '')) {
          return `<div class="art-render art-render-svg"><img src="${esc(bust)}" alt="${esc(a.title)}"></div>`;
        }
        const hint = (a.parts && a.parts.warn) || '这份图纸建议导出 PDF 或 SVG 再发布';
        return `<div class="art-hint"><span class="glyph">⌗</span>
          <span>${esc(hint)}</span>
          <a class="ghost-btn" href="${esc(bust)}" target="_blank" rel="noopener">在新标签打开原文件</a></div>`;
      }
      case 'doc': {
        /* text/* 塞进 <object> 浏览器根本不渲染（只认 pdf 等插件类型），
           表现为一片空白。这里改成自己抓文本铺出来。 */
        const mime = a.mime || '';
        if (/^text\//.test(mime) || /\.(txt|md|log|csv|json|ya?ml)$/i.test(a.file_name || a.title || '')) {
          return `<div class="art-render"><pre class="art-text" data-src="${esc(bust)}">${esc(a.title)}</pre></div>`;
        }
        return `<div class="art-render"><object data="${esc(bust)}" type="${esc(mime || 'application/pdf')}"
            class="art-doc"><img src="${esc(snap || a.thumb || '')}" alt="${esc(a.title)}"></object></div>`;
      }
      case 'image':
        return `<div class="art-render"><img src="${esc(bust)}" alt="${esc(a.title)}"></div>`;
      default:
        return `<div class="art-render"><img src="${esc(a.thumb || '')}" alt="${esc(a.title)}"></div>`;
    }
  }

  /* 三维渲染。model-viewer 本地化在 static/vendor/ —— 不能依赖 CDN：
     成果台常在内网/离线的机器上看，外链拉不到就是一片空白。 */
  function renderModel(src, a, part) {
    const ex = ((part && part.path) || a.source_path || a.src || '').toLowerCase();
    const label = (part && part.label) || a.title;
    /* 就绪判断以「自定义元素有没有注册」为准：模块脚本是延迟执行的，
       读 window.modelViewer 时经常还没到位，判早了就把能渲染的模型也毙了。 */
    if (window.modelViewerError) {
      return `<div class="art-hint error"><span class="glyph">◈</span>
        <span>三维渲染器加载失败</span>
        <span class="mono">${esc(window.modelViewerError)}</span></div>`;
    }
    if (!MODEL_EXT.includes(ex.replace(/^.*\./, '')) && !/\.(glb|gltf|obj|stl|ply|3ds|dae|3mf)(\?|$)/.test(ex)) {
      return `<div class="art-hint"><span class="glyph">◈</span>
        <span>${esc((a.parts && a.parts.render_hint) || '这个格式需要先转成 glb/obj 才能在页面里转起来')}</span>
        <a class="ghost-btn" href="${esc(src)}" target="_blank" rel="noopener">下载原文件</a></div>`;
    }
    /* 三维最大的坑是手势打架：model-viewer 自己要吃拖动去旋转，
       标注层又要吃拖动去框选。两个都想要 = 两个都半残。
       所以这里把两种模式做成显式切换，切换时真的把 camera-controls
       关掉（不是靠覆盖层压），并在画面上写清楚当前是哪种模式。 */
    const anno = state.mvMode === 'anno';
    return `<div class="art-render"><model-viewer src="${esc(src)}"
      ${anno ? '' : 'camera-controls auto-rotate'}
      ar-environments="neutral" shadow-intensity="1"
      alt="${esc(label)}" style="width:100%;height:100%"></model-viewer>
      <span class="art-mv-hint">${anno ? '标注中：拖动框选，模型暂不可旋转'
        : '查看中：拖动可旋转，点右上角切到标注'}</span>
      <div class="art-mv-modes" style="position:absolute;top:10px;left:10px;z-index:4">
        <button class="art-tbtn" type="button" data-mv-mode="view"
          title="旋转查看模型">旋转查看</button>
        <button class="art-tbtn" type="button" data-mv-mode="anno"
          title="在模型上标注">标注</button>
      </div></div>`;
  }

  /* 模式切换：动 model-viewer 的属性，而不是动覆盖层的 z-index。 */
  function applyMvMode() {
    const mv = document.querySelector('.art-render model-viewer');
    if (!mv) return;
    const anno = state.mvMode === 'anno';
    if (anno) {
      mv.removeAttribute('camera-controls');
      mv.removeAttribute('auto-rotate');
    } else {
      mv.setAttribute('camera-controls', '');
      mv.setAttribute('auto-rotate', '');
    }
    /* 标注模式同时把标注层接上：不然点了没反应，用户会以为按钮坏了。
       浏览模式必须让覆盖层彻底让路 —— 否则它会吃掉 model-viewer 的
       拖动和滚轮，旋转／缩放看起来就"没反应"。 */
    applyArmed(anno || (noteArmed() && state.mvMode !== 'view'));
  }

  /* 三维／图纸这类可交互画面：进成果时默认停在浏览模式，
     标注要用户自己点一下才接管手势（之前默认 armed，旋转永远失灵）。 */
  const GESTURE_KINDS = new Set(['model3d', 'drawing']);
  function defaultGestureMode(a) {
    if (!a || !GESTURE_KINDS.has(a.kind)) return;
    if (state.gestureArtifact === a.id) return;
    state.gestureArtifact = a.id;
    state.mvMode = 'view';
    state.noteArmed = false;
  }

  /* ------------------------------------------------------------ 文字就地编辑（需求 4） */
  function renderTextEditor(a) {
    const text = state.textDirty ? (state.textDraft || '') : (state.textBase || '');
    return `<div class="art-render art-render-text">
      <div class="art-text-bar">
        <span class="art-text-kind">${esc(extOf(a) || '文本')}</span>
        <span class="art-text-hint">改的是成果台里的这一份；原项目文件不动，应用时连同标注交给 agent</span>
        <button class="ghost-btn" id="btnTextSave" type="button"${state.textDirty ? '' : ' disabled'}>保存并生效</button>
        <button class="ghost-btn" id="btnTextRevert" type="button">放弃改动</button>
      </div>
      <textarea class="art-text-area" id="textArea" spellcheck="false"
        aria-label="成果内容源码">${esc(text)}</textarea>
    </div>`;
  }

  function mountTextEditor(inner, a) {
    const ta = inner.querySelector('#textArea');
    if (!ta) return;
    ta.value = state.textDirty ? (state.textDraft || '') : (state.textBase || '');
    ta.addEventListener('input', () => {
      state.textDraft = ta.value;
      state.textDirty = ta.value !== state.textBase;
      const b = inner.querySelector('#btnTextSave');
      if (b) b.disabled = !state.textDirty;
    });
    ta.addEventListener('keydown', (ev) => {
      ev.stopPropagation();                 // 编辑框里打字不该触发舞台快捷键
      if ((ev.metaKey || ev.ctrlKey) && ev.key === 's') { ev.preventDefault(); saveText(); }
    });
    const sv = inner.querySelector('#btnTextSave');
    if (sv) sv.addEventListener('click', saveText);
    const rv = inner.querySelector('#btnTextRevert');
    if (rv) rv.addEventListener('click', () => {
      state.textDraft = state.textBase;
      state.textDirty = false;
      renderStage();
    });
    ta.focus();
  }

  async function toggleTextEdit() {
    const a = current();
    if (!a || !isEditableText(a)) return;
    if (state.editText) {
      if (state.textDirty && !window.confirm('有没保存的改动，确定先放着？')) return;
      state.editText = false;
      state.textDraft = '';
      state.textDirty = false;
      renderStage();
      return;
    }
    try {
      const r = await req('GET', `${API}/${a.id}/text`);
      state.textBase = r.text || '';
      state.textDraft = state.textBase;
      state.textDirty = false;
      state.editText = true;
      renderStage();
    } catch (err) {
      toast(`打开编辑器失败：${err.message || err}`, 'warn');
    }
  }

  async function saveText() {
    const a = current();
    if (!a || !state.textDirty) return;
    try {
      const r = await req('PUT', `${API}/${a.id}/text`, { text: state.textDraft });
      state.textBase = state.textDraft;
      state.textDirty = false;
      state.editText = false;
      const d = r.changed || {};
      await loadOne(a.id);
      /* 保存完就回到渲染视图 —— 成果台里看到的就是刚存进去的那一版 */
      state.editText = false;
      renderStage();
      toast(d.edited
        ? `已保存并生效（相对发布时 +${d.added} / -${d.removed} 行）`
        : '已保存并生效', 'ok');
    } catch (err) {
      toast(`保存失败：${err.message || err}`, 'warn');
    }
  }

  /* ------------------------------------------------------------ 标注气泡层 */
  const SEV_LABEL = { blocker: '阻断', major: '重要', minor: '次要' };
  /* 服务端 _norm_rect 会把宽高夹到 [0.005, ...]，点选存回来不可能是 0，
     所以靠「小于 2% 就算点」来区分点标注和框标注，和拖拽阈值同一把尺子。 */
  const POINT_MAX = 0.02;

  /* 「能不能落标注」只看状态，不看 DOM class —— 之前 armed 是个 class，
     每次 renderOverlay() 都被自己清掉，于是按钮按下去高亮一闪就没了，
     后面点画面什么也不会发生。这里改成单一状态源。 */
  function noteArmed() {
    return !!current() && state.noteArmed;
  }

  /* 标注在位时，除了给覆盖层开 pointer-events，还要给 #stage 挂上 armed。
     浏览器认的是 touch-action / user-select，这些属性只在「标注在位」时该被接管：
     不接 → 触屏长按出系统文本选择气泡、拖动变成选中文字、画面里滚不动；
     一直接 → 用户只是翻看成果时也没法滚动和选字。
     所以 armed 必须是成对出现的两种状态，不能只改其中一个。 */
  function applyArmed(on) {
    const flag = !!on;
    const ov = $('overlay');
    if (ov) ov.classList.toggle('armed', flag);
    const st = $('stage');
    if (st) st.classList.toggle('armed', flag);
  }

  /* 画上所有标记：已存的标注 + 还没写说明的草稿。
     草稿只是本地状态 —— 服务端拒收空说明（add_annotation 会 ValueError），
     所以先落在屏幕上让人看见序号，写完说明才算提交。 */
  function renderOverlay() {
    const ov = $('overlay');
    if (!ov) return;
    const a = current();
    applyArmed(noteArmed());
    /* 选着某个部件时，只画这个部件上的标注：否则框会漂在别的零件上，
       用户以为标错位置，其实那是一条属于另一个部件的意见。 */
    const curPart = state.partId || '';
    const notes = a ? (a.annotations || []).filter(
      (n) => ((n.anchor && n.anchor.part) || '') === curPart) : [];
    const marks = [
      ...notes.map((n) => ({
        key: n.id, id: n.id, seq: n.seq, rect: n.rect, body: n.body,
        severity: n.severity, resolved: n.resolved, draft: false,
      })),
      ...state.drafts.map((d) => ({
        key: d.key, id: d.key, seq: d.seq, rect: d.rect, body: d.body,
        severity: d.severity, resolved: false, draft: true,
      })),
    ];
    if (!marks.length) { ov.innerHTML = ''; return; }

    const box = ov.parentElement.getBoundingClientRect();
    ov.innerHTML = marks.map((m) => {
      const r = m.rect || { x: 0.3, y: 0.3, w: 0.25, h: 0.18 };
      const point = (r.w || 0) <= POINT_MAX && (r.h || 0) <= POINT_MAX;
      const left = r.x * box.width;
      const top = r.y * box.height;
      const tip = esc(`${SEV_LABEL[m.severity] || ''}${m.body ? ' · ' + m.body : '（待填写说明）'}`);
      const cls = `art-${point ? 'pin' : 'box'}`
        + `${m.resolved ? ' resolved' : ''}${m.draft ? ' draft' : ''}`
        + `${m.id === state.activeNoteId ? ' active' : ''}`;
      /* 框标注把说明印在框边：作者一眼看到「第 3 框：底部留白不对」，不用来回对照 */
      const caption = point || !m.body ? ''
        : `<i class="art-pin-body">${esc(m.body)}</i>`;
      const size = point ? '' : `;width:${r.w * box.width}px;height:${r.h * box.height}px`;
      return `<span class="${cls}" data-id="${esc(m.id)}" data-sev="${m.severity}" title="${tip}"
        style="left:${left}px;top:${top}px${size}"><b>${m.seq}</b>${caption}</span>`;
    }).join('');
  }

  /* 极简 toast：评审动作要立刻有回执，否则用户以为没点上又点一遍 */
  let toastTimer = null;
  function toast(msg, kind) {
    let el = $('artToast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'artToast';
      el.className = 'art-toast';
      document.body.appendChild(el);
    }
    el.dataset.kind = kind || 'info';
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
  }

  /* ------------------------------------------------------------ 落标注 */
  /* 服务端不下发 DOM selector（沙箱里拿不到），靠鼠标/触摸在快照上直接落：
       点选 → 一个序号圆点
       框选 → 拖出矩形
     存成相对坐标 rect（w/h 为 0 即点），换分辨率/换尺寸都还对得上。 */
  let draw = null;

  function drawToRect(x0, y0, x1, y1) {
    const x = Math.min(x0, x1);
    const y = Math.min(y0, y1);
    return {
      x: Number(x.toFixed(4)),
      y: Number(y.toFixed(4)),
      w: Number(Math.abs(x1 - x0).toFixed(4)),
      h: Number(Math.abs(y1 - y0).toFixed(4)),
    };
  }

  /* 落点用哪张画布？点选/框选都发生在预览图上。
     live 模式下 iframe 会吃掉事件，所以 live 一律按 snapshot 的盒子换算。 */
  function stageInner() {
    const st = $('stage');
    return st && st.querySelector('.art-stage-inner');
  }

  function toNorm(ev) {
    const inner = stageInner();
    if (!inner) return null;
    const b = inner.getBoundingClientRect();
    if (!b.width || !b.height) return null;
    if (ev.clientX < b.left || ev.clientX > b.right
     || ev.clientY < b.top || ev.clientY > b.bottom) return null;   // 画布外
    return { x: (ev.clientX - b.left) / b.width, y: (ev.clientY - b.top) / b.height, box: b };
  }

  /* 需求 4 的「框选后标注」：把用户刚才选中的那几行字捞出来当说明草稿。

     为什么不在 drag 结束时才读：pointerdown 一落下，选区就没了，事后读回来
     永远是空的。所以必须在按下那一刻先拍一张快照。

     三处都得看，因为文字可能落在三个地方：
       - 编辑态的 textarea：选区不在 Selection API 里，得读 selectionStart/End
       - 预览用的 iframe / <object>：是独立文档，父页面的 getSelection 读不到
       - 顶层的普通 DOM
     跨源的内嵌文档读不了（浏览器不让），这种情况就退回纯几何标注 ——
     框还是框，只是没有原文可引，不猜。 */
  function pickedText() {
    const MAX = 400;
    const tidy = (s) => (s || '').replace(/\s+/g, ' ').trim().slice(0, MAX);

    const ta = document.activeElement;
    if (ta && ta.tagName === 'TEXTAREA' && ta.selectionStart != null
        && ta.selectionEnd != null && ta.selectionStart !== ta.selectionEnd) {
      const t = tidy(ta.value.slice(ta.selectionStart, ta.selectionEnd));
      if (t) return t;
    }
    const inner = stageInner();
    const frames = [];
    if (inner) frames.push(...inner.querySelectorAll('iframe, object, embed'));
    for (const f of frames) {
      let doc = null;
      try { doc = f.contentDocument; } catch { doc = null; }   // 跨源就当没有
      if (!doc) continue;
      const sel = doc.getSelection && doc.getSelection();
      const t = tidy(sel && sel.toString());
      if (t) return t;
    }
    const own = window.getSelection && window.getSelection();
    return tidy(own && own.toString());
  }

  /* 手势只在 pointerdown 那一刻认舞台，之后一律听 window。

     之前 move/up 直接挂在 #stage 上，有两个会丢手势的洞：
       一是 SSE 推一次新版本、renderStage() 就把舞台整块换掉，用户正按着的手
          瞬间落在一个已经从文档里摘掉的节点上，pointerup 永远等不到；
       二是拖出画面边界后事件跑回 body，#stage 再也收不到。
     window 级的监听两头都不沾。 */
  function bindDraw() {
    $('stage').addEventListener('pointerdown', drawStart);
  }

  function drawStart(ev) {
    const a = current();
    if (!a || !noteArmed() || !ev.isPrimary || ev.button > 0) return;
    /* 落在已有标注上：长按 = 打开菜单（改/删），单击 = 选中定位。
       这里必须先把手势「欠」下来，不能直接 return —— 否则用户想删一个框，
       结果长按变成了给旁边空白处加新标注。 */
    const hit = ev.target.closest && ev.target.closest('.art-box, .art-pin');
    const p = toNorm(ev);
    if (!p) return;
    /* 到这一步手势已经确定归我们了，跟浏览器打招呼：别再开原生选区、
       别再触发长按气泡、别把这次按下当成拖拽起点。
       CSS 侧的 touch-action:none 负责滚动与缩放，preventDefault 负责
       选区与兼容性鼠标事件 —— 两边都要，少一边就会各丢一半。 */
    if (ev.cancelable) ev.preventDefault();
    const ov = $('overlay');
    draw = {
      id: ev.pointerId, box: p.box, x0: p.x, y0: p.y, mode: null,
      hitId: hit ? hit.dataset.id : '', px: ev.clientX, py: ev.clientY,
      moved: false, longFired: false, hitStart: !!hit,
      /* 文字类成果里，用户往往先框选一段字再点画面；把这段字带上，
         说明框里就有内容可改，而不是让人再抄一遍。
         必须在这里（pointerdown 当下）取：再往后拖一下，选区就没了。 */
      selectedText: pickedText(),
      /* 视频标注要记「第几个画面时间点」：在按下这一刻读 currentTime，
         不是松手时读 —— 松手前画面可能还在播，记下来的就不是看到的那一帧。 */
      t: videoTimeAt(),
    };
    if (hit) {
      /* 长按只在「没挪动」的时候生效：按住拖出框是在调位置，不是要删。 */
      draw.timer = setTimeout(() => {
        if (draw && !draw.moved && hit.isConnected) {
          draw.longFired = true;
          draw.node = null;
          unbindDraw();
          openNoteMenu(hit.dataset.id, ev.clientX, ev.clientY);
          draw = null;
        }
      }, LONG_PRESS_MS);
    }
    window.addEventListener('pointermove', drawMove);
    window.addEventListener('pointerup', drawEnd);
    window.addEventListener('pointercancel', drawCancel);
  }

  function drawCancel() {
    if (draw && draw.timer) clearTimeout(draw.timer);
    if (draw && draw.node) draw.node.remove();
    unbindDraw();
  }

  function unbindDraw() {
    window.removeEventListener('pointermove', drawMove);
    window.removeEventListener('pointerup', drawEnd);
    window.removeEventListener('pointercancel', drawCancel);
  }

  function drawMove(ev) {
    if (!draw || ev.pointerId !== draw.id) return;
    const dx = ev.clientX - draw.px;
    const dy = ev.clientY - draw.py;
    if (!draw.moved && Math.hypot(dx, dy) < DRAG_PX) return;
    if (!draw.moved) {
      /* 越过门槛的那一刻才认这是一次框选：从点标注切到框标注，
         而不是让用户先去点一下「框选」按钮。 */
      draw.moved = true;
      draw.mode = 'box';
      if (draw.timer) { clearTimeout(draw.timer); draw.timer = null; }
      const ov = $('overlay');
      if (ov && !draw.hitStart) {
        draw.node = document.createElement('span');
        draw.node.className = 'art-draw';
        ov.appendChild(draw.node);
      }
    }
    if (!draw.node) return;
    const r = drawToRect(draw.x0, draw.y0,
      (ev.clientX - draw.box.left) / draw.box.width,
      (ev.clientY - draw.box.top) / draw.box.height);
    Object.assign(draw.node.style, {
      left: `${r.x * draw.box.width}px`, top: `${r.y * draw.box.height}px`,
      width: `${r.w * draw.box.width}px`, height: `${r.h * draw.box.height}px`,
    });
  }

  async function drawEnd(ev) {
    if (!draw || ev.pointerId !== draw.id) return;
    if (draw.timer) { clearTimeout(draw.timer); draw.timer = null; }
    const d = draw;
    if (d.node) d.node.remove();
    draw = null;
    unbindDraw();
    if (d.longFired) return;
    const a = current();
    if (!a) return;

    /* 点在已有标注上：只做定位，不叠新的标注。 */
    if (d.hitStart && !d.moved) {
      if (d.hitId) focusNote(d.hitId, { pulse: true });
      return;
    }

    const p = toNorm(ev) || { x: d.x0, y: d.y0 };
    const r = drawToRect(d.x0, d.y0, p.x, p.y);
    /* 没拖动 → 点标注；拖动了但框太小 → 当误触丢掉。
       两种都不要再问用户「你现在想干嘛」，手势本身就是意图。 */
    if (!d.moved) {
      if (r.w > POINT_MAX || r.h > POINT_MAX) return;
      r.w = 0; r.h = 0;
      /* 写 d 不是 draw：上面已经把模块级的 draw 置空了，这里再写 draw.mode
         会直接抛 TypeError，后面的 addDraft 永远跑不到 —— 表现就是「单击完全
         加不出编号」。 */
      d.mode = 'point';
    } else if (r.w < POINT_MAX || r.h < POINT_MAX) {
      return;
    }
    addDraft(r, { text: d.selectedText || '', t: d.t });
  }

  /* ------------------------------------------------------------ 标注草稿
     服务端 add_annotation 拒收空说明（body 为空直接 ValueError 400），所以
     「先标后写」不能一步到服务器：标记先落在本地，画面上立刻出现编号，
     说明写完、按下保存，才真正 POST。取消就整条丢掉，服务器上从来没有过它。 */
  let draftSeq = 0;

  function nextSeq() {
    const a = current();
    const used = a ? (a.annotations || []).map((n) => n.seq) : [];
    return used.concat(state.drafts.map((d) => d.seq)).reduce((m, s) => Math.max(m, s), 0) + 1;
  }

  function addDraft(rect, opts = {}) {
    const picked = (opts.text || '').trim();
    /* 框选了文字就直接把选中的字填进说明框：评审想说的话已经说了一半，
       让人再抄一遍只会让他们懒得写 —— 写不出说明的标注等于没标。 */
    const cur = current();
    const d = { key: `draft-${++draftSeq}`, seq: nextSeq(), rect, severity: 'major',
                body: picked,
                anchor: {
                  rect, text: picked, part: state.partId || '',
                  /* 有时间点才带 t/fps：静态图上写一个「0 秒」会让人误以为
                     「出问题的是这一帧」，比不写更糟。帧率也没有就不写。 */
                  ...(opts.t != null ? { t: opts.t } : {}),
                  ...(cur && videoFps(cur) ? { fps: videoFps(cur) } : {}),
                  /* 多页图纸：标注落在第几页要记下来，翻页时才知道它是哪一条 */
                  ...(cur && isPdfView(cur) && (state.pdfPage || 1) > 1
                      ? { page: state.pdfPage } : {}),
                } };
    state.drafts.push(d);
    state.activeNoteId = d.key;
    renderNotes();
    renderOverlay();
    const ta = $('annoList').querySelector(`.art-note[data-id="${d.key}"] [data-ctext]`);
    if (ta) {
      ta.focus();
      const n = ta.value.length;
      ta.setSelectionRange(n, n);
    }
  }

  function dropDraft(key) {
    const i = state.drafts.findIndex((d) => d.key === key);
    if (i < 0) return;
    state.drafts.splice(i, 1);
    if (state.activeNoteId === key) state.activeNoteId = null;
    renderNotes();
    renderOverlay();
  }

  /* 把一条草稿落库 */
  async function saveDraft(key) {
    const d = state.drafts.find((x) => x.key === key);
    const a = current();
    if (!d || !a) return;
    const body = (d.body || '').trim();
    if (!body) { toast('先写一句要改什么', 'warn'); return; }
    try {
      await req('POST', `${API}/${a.id}/annotations`, {
        surface: a.kind === 'page' && state.mode === 'live' ? 'live' : a.kind,
        severity: d.severity,
        body,
        /* anchor 里带上部件 id：换部件看图时，那条意见还能落在原处；
           视频再带上时间点/帧率，服务端据此存「第几秒、几帧」。 */
        anchor: { rect: d.rect, text: d.anchor && d.anchor.text || '',
                  part: state.partId || '',
                  ...(d.anchor && d.anchor.t != null ? { t: d.anchor.t } : {}),
                  ...(d.anchor && d.anchor.fps ? { fps: d.anchor.fps } : {}),
                  ...(d.anchor && d.anchor.page ? { page: d.anchor.page } : {}) },
      });
      state.drafts = state.drafts.filter((x) => x.key !== key);
      if (state.activeNoteId === key) state.activeNoteId = null;
      await loadOne(a.id);
      toast(`已添加第 ${d.seq} 条标注`, 'ok');
    } catch (err) {
      toast(`标注没存上：${err.message || err}`, 'warn');
    }
  }

  /* 提交前把草稿先落库，返回「还没处理掉的条数」。
   原来是靠按钮置灰逼用户自己先存（drafts.length > 0 就两个键一起灰），
   结果画了一个标注没写说明，按钮就变成点不动的死键。
   这里改成：点「确认提交」自己兜住 —— 写得出来的直接存，
   写不出来的报数并停下，别让人以为已经交出去了。 */
  async function flushDrafts() {
    let left = 0;
    for (const d of [...state.drafts]) {
      if (!(d.body || '').trim()) { left++; continue; }
      await saveDraft(d.key);
      /* saveDraft 失败时会保留这条草稿并自己 toast，所以存完再查一次 */
      if (state.drafts.some((x) => x.key === d.key)) left++;
    }
    return left;
  }

  /* 需求的 5 条通道逐条播报。toast 只能一句话，这里要让人知道返工单落在哪、
     会话排没排上、agent 醒没醒 —— 所以进一个可读的弹层。 */
  function showApplyResult(r) {
    const c = r.channels || {};
    /* 「送到了」和「对方已经看见了」是两回事。
       对话框里的说法必须跟实际投递方式一致：落在磁盘上的文件是交接，
       不是即时送达；宁可说得保守，也不要让人以为 agent 已经在改了。 */
    const line = (k, label, v) => `<li class="${v && v.ok ? 'ok' : 'bad'}">
      <b>${label}</b><span>${esc(v && v.ok
        ? (v.path || (v.queued ? `已排进队列（第 ${v.queued} 条）` : '已唤醒')) +
          (v.dedup ? '（已存在，没重复排）' : '')
        : (v && v.reason) || '没送出去')}
        ${v && v.ok && v.note ? `<em class="art-apply-note">${esc(v.note)}</em>` : ''}</span></li>`;
    const el = document.createElement('div');
    el.className = 'art-apply';
    el.id = 'applyResult';
    el.innerHTML = `
      <div class="art-apply-head"><b>应用结果</b>
        <button class="icon-btn" type="button" data-close="1">✕</button></div>
      <ul class="art-apply-list">
        ${line('project_dir', '原项目目录', c.project_dir)}
        ${line('session_queue', '对应会话', c.session_queue)}
        ${line('agent_wake', '唤醒 agent', c.agent_wake)}
      </ul>
      <p class="art-apply-foot">共 ${r.notes || 0} 条意见${r.text_changed ? '（含你在成果台里的手工改动）' : ''}
        ${r.exact_session ? '，按成果所属的那次会话投递' : (r.session_id ? '，按项目最近的会话投递' : '')}</p>`;
    document.body.appendChild(el);
    el.addEventListener('click', (ev) => {
      if (ev.target.closest('[data-close]') || ev.target === el) el.remove();
    });
    toast(r.ok ? '已送回原项目' : '部分通道没送出去，详见结果', r.ok ? 'ok' : 'warn');
  }

  /* ------------------------------------------------------------ 改 / 删 */
  /* 路由带成果 id：/api/artifacts/{aid}/annotations/{nid}。
     少了 aid 服务端匹配不到，别指望 id 全局唯一。 */
  async function patchNote(id, fields) {
    const a = current();
    if (!a) return;
    try {
      await req('PATCH', `${API}/${a.id}/annotations/${id}`, fields);
      await loadOne(a.id);
      toast('已更新', 'ok');
    } catch (err) {
      toast(`修改没存上：${err.message || err}`, 'warn');
    }
  }

  /* 两步确认：标注区一排 ✕ 挨着，一按就删太容易误伤 */
  async function delNote(id) {
    const a = current();
    if (!a) return;
    try {
      await req('DELETE', `${API}/${a.id}/annotations/${id}`);
      if (state.activeNoteId === id) state.activeNoteId = null;
      await loadOne(a.id);
      toast('标注已删除', 'ok');
    } catch (err) {
      toast(`删除失败：${err.message || err}`, 'warn');
    }
  }

  /* ------------------------------------------------------------ 长按菜单
     需求 3：长按已有编号/框 → 弹出菜单，能改说明、能改严重度、能删、能定位。
     桌面端没长按，所以右键也走同一个菜单 —— 一套菜单、两个入口，
     不用为了桌面另做一排常驻按钮。 */
  let menuEl = null;
  function closeNoteMenu() {
    if (menuEl) { menuEl.remove(); menuEl = null; }
  }

  function openNoteMenu(id, cx, cy) {
    closeNoteMenu();
    const a = current();
    const n = a && (a.annotations || []).find((x) => x.id === id);
    /* 刚点出来、还没写说明的标注是「草稿」，只存在于 state.drafts 里。
       不认它的话，用户最长按的恰恰是自己刚点的那个 —— 菜单永远不出来。 */
    const draft = n ? null : state.drafts.find((d) => d.key === id);
    if (!n && !draft) return;
    const target = n || { id, seq: draft.seq, body: draft.body, severity: draft.severity,
                          resolved: false, status: 'open' };
    focusNote(id, { pulse: false });

    if (draft) {
      const el2 = document.createElement('div');
      el2.className = 'art-note-menu';
      el2.setAttribute('role', 'menu');
      el2.innerHTML = `
        <div class="art-note-menu-head"><b>${draft.seq}</b>
          <span>${esc(draft.body || '（还没写说明）')}</span></div>
        <button type="button" role="menuitem" class="art-note-menu-item" data-act="goto">填写说明</button>
        <button type="button" role="menuitem" class="art-note-menu-item danger" data-act="delete">删除这条标注</button>`;
      document.body.appendChild(el2);
      el2.style.left = `${Math.max(8, Math.min(cx, window.innerWidth - (el2.offsetWidth || 220) - 8))}px`;
      el2.style.top = `${Math.max(8, Math.min(cy, window.innerHeight - (el2.offsetHeight || 140) - 8))}px`;
      menuEl = el2;
      el2.addEventListener('click', (ev) => {
        const btn = ev.target.closest('[data-act]');
        if (!btn) return;
        closeNoteMenu();
        if (btn.dataset.act === 'delete') {
          state.drafts = state.drafts.filter((d) => d.key !== id);
          state.activeNoteId = null;
          renderNotes(); renderOverlay();
          toast('草稿标注已丢弃', 'ok');
        } else {
          focusNote(id);
          const ta = $('annoList').querySelector(`.art-note[data-id="${id}"] [data-ctext]`);
          if (ta) { ta.focus(); ta.select(); }
        }
      });
      return;
    }

    const items = n.resolved ? [] : [
      { act: 'resolve', label: n.status === 'resolved' ? '标为未解决' : '标为已解决' },
      { act: 'goto', label: '在右栏编辑说明' },
      { act: 'copy', label: '复制说明' },
    ];
    items.push({ act: 'delete', label: '删除这条标注', danger: true });

    const el = document.createElement('div');
    el.className = 'art-note-menu';
    el.setAttribute('role', 'menu');
    el.innerHTML = `
      <div class="art-note-menu-head">
        <b>${n.seq}</b>
        <span>${esc(n.body || '（没写说明）')}</span>
      </div>
      ${items.map((it) => `<button type="button" role="menuitem"
        class="art-note-menu-item${it.danger ? ' danger' : ''}" data-act="${it.act}">${esc(it.label)}</button>`).join('')}
      ${n.resolved ? '<p class="art-note-menu-tip">这条已经解决，可以标回未解决</p>' : ''}`;
    document.body.appendChild(el);

    /* 先量再摆：贴着手指/鼠标放，超出视口就往里收 */
    const w = el.offsetWidth || 220;
    const h = el.offsetHeight || 140;
    el.style.left = `${Math.max(8, Math.min(cx, window.innerWidth - w - 8))}px`;
    el.style.top = `${Math.max(8, Math.min(cy, window.innerHeight - h - 8))}px`;
    menuEl = el;

    el.addEventListener('click', (ev) => {
      const btn = ev.target.closest('[data-act]');
      if (!btn) return;
      closeNoteMenu();
      const act = btn.dataset.act;
      if (act === 'delete') delNote(id);
      else if (act === 'resolve') patchNote(id, { status: n.resolved ? 'open' : 'resolved' });
      else if (act === 'goto') { focusNote(id); const ta = $(`annoList`).querySelector(`.art-note[data-id="${id}"] [data-ctext]`); if (ta) { ta.focus(); ta.select(); } }
      else if (act === 'copy') {
        const text = `#${n.seq} ${n.body}`;
        (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject())
          .then(() => toast('说明已复制', 'ok'))
          .catch(() => toast('复制失败，浏览器不给剪贴板权限', 'warn'));
      }
    });
  }

  document.addEventListener('pointerdown', (ev) => {
    if (menuEl && !(ev.target.closest && ev.target.closest('.art-note-menu'))) closeNoteMenu();
  }, true);
  document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') closeNoteMenu(); });

  /* 渲染器是异步就绪的：首次打开三维成果时多半还没加载完，
     等它好了自己重画一次，别让用户手动切一次成果才发现。 */
  window.addEventListener('art:renderer-ready', () => {
    const a = current();
    if (a && (a.kind === 'model3d' || (a.parts && a.parts.count))) renderStage();
  });

  /* 标注工具的开关与状态同步 */
  function setNoteBtns(on) {
    ['point', 'box'].forEach((m) => {
      const b = document.querySelector(`[data-note-mode="${m}"]`);
      if (b) b.disabled = !on;
    });
  }

  function syncModeButtons() {
    const box = $('annoModes');
    if (!box) return;
    box.querySelectorAll('[data-note-mode]').forEach((b) => {
      const on = noteArmed() && b.dataset.noteMode === state.noteMode;
      b.classList.toggle('active', on);
      b.setAttribute('aria-checked', on ? 'true' : 'false');
    });
    const hint = $('annoHint');
    if (hint) hint.dataset.on = noteArmed() ? '1' : '0';
  }

  function setNoteMode(mode, { toggle } = {}) {
    const next = toggle && noteArmed() && state.noteMode === mode ? 'off' : (mode || 'point');
    state.noteArmed = next !== 'off';
    if (next !== 'off') state.noteMode = next;
    if (state.noteArmed && !current()) state.noteArmed = false;   // 没选中成果就没什么可标
    renderOverlay();
    syncModeButtons();
    renderNotes();
  }

  /* 右栏卡 ↔ 舞台标记 双向定位 */
  function focusNote(id, { pulse } = {}) {
    $('annoList').querySelectorAll('.art-note').forEach((x) => x.classList.toggle('active', x.dataset.id === id));
    const card = $('annoList').querySelector(`.art-note[data-id="${id}"]`);
    if (card) card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    const ov = $('overlay');
    const mark = ov && ov.querySelector(`[data-id="${id}"]`);
    if (mark && pulse !== false) {
      mark.classList.remove('pulse');
      void mark.offsetWidth;
      mark.classList.add('pulse');
    }
    if (mark) mark.classList.toggle('active', true);
    /* 视频：点某条标注时把画面跳到那一刻，别让人自己拖进度条找。 */
    seekToNote(id);
  }

  /* ------------------------------------------------------------ 右栏标注 */
  /* 列表是整块 innerHTML 重画的。重画前先记住「谁在打字、打到哪儿」，
     重画后原样还回去。

     为什么必须还：SSE 推一次新版本、一次 loadOne() 回来，都会顺手调
     renderNotes()，输入框整个换掉 —— 人正打到一半，光标就没了，
     前面敲的字看着还在其实节点已经不是那个了。焦点丢了不说，
     还很容易让人以为界面卡住。 */
  function captureTyping() {
    const act = document.activeElement;
    if (!act || !act.matches || !act.matches('[data-ctext]')) return null;
    return { id: act.dataset.ctext, start: act.selectionStart, end: act.selectionEnd };
  }

  function restoreTyping(t) {
    if (!t) return;
    const ta = $('annoList').querySelector(`[data-ctext="${t.id}"]`);
    if (!ta) return;
    ta.focus();
    try { ta.setSelectionRange(t.start, t.end); } catch { /* 某些浏览器对 disabled 会抛 */ }
  }

  function renderNotes() {
    const typing = captureTyping();
    renderNotesInner();
    restoreTyping(typing);
  }

  /* 锚点位置标签：视频写「第几秒 / 第几帧」，多页图纸写第几页。
     静态图不写 —— 一条没有位置的标注总比带个假位置强。 */
  function anchorTag(n) {
    const an = n.anchor || {};
    const bits = [];
    if (Number.isFinite(an.t)) {
      bits.push(esc(fmtTime(an.t)));
      if (Number.isFinite(an.frame)) bits.push(`第 ${esc(an.frame)} 帧`);
    }
    if (Number.isFinite(an.page) && an.page > 1) bits.push(`第 ${esc(an.page)} 页`);
    if (!bits.length) return '';
    return `<span class="n-at" title="标注位置">@ ${bits.join(' · ')}</span>`;
  }

  function renderNotesInner() {
    const a = current();
    const el = $('annoList');
    setNoteBtns(!!a);
    if (!a) {
      el.innerHTML = `<div class="art-hint"><span class="glyph">◌</span><span>未选择成果</span></div>`;
      $('annoCount').textContent = '待处理 0';
      $('btnSubmit').disabled = true;
      return;
    }
    if (a) syncModeButtons();

    const drafts = state.drafts;
    const open = (a.annotations || []).filter((n) => !n.resolved);
    const done = (a.annotations || []).filter((n) => n.resolved);
    $('annoCount').textContent = drafts.length
      ? `${open.length} + ${drafts.length} 待写`
      : `待处理 ${open.length}`;

    /* 两个键现在只分一件事的两条路：「继续编辑」不提交，「确认提交」交给 agent。
       原来这里是两个**都能**提交的键（一个走 /dispatch、一个走 /apply），
       文案分不出差别，连注释自己都写着「它俩是同一件事的两条路」——
       这就是用户说的「定义有歧义」。

       「无效」是另一回事：两个键都跟 drafts.length > 0 绑在一起置灰，
       画了一个标注没保存说明就同时变灰；实测点下去 0 个网络请求，
       按钮看上去就是坏的。现在：继续编辑永远可点；确认提交有东西可交就点得动，
       草稿由提交动作自己先落库，不再让人猜自己漏了哪一步。 */
    const btn = $('btnSubmit');
    const dirty = open.length > 0 || drafts.length > 0 || state.textDirty;
    btn.disabled = state.applying || !dirty;
    btn.textContent = state.applying ? '提交中…' : '确认提交';
    btn.title = drafts.length
      ? `${open.length} 条意见、${drafts.length} 条还没写完的标注；点下去会先存后交`
      : (open.length ? `把这 ${open.length} 条意见交给 agent 按内容去改` : '还没有可提交的意见');

    const apply = $('btnApply');   // 「继续编辑」：不发请求，只把标注工具重新架起来
    if (apply) {
      apply.disabled = !!state.applying;
      apply.title = drafts.length
        ? `还有 ${drafts.length} 条草稿没存，继续标就行，不会丢`
        : '先不提交，继续在这个成果上标';
    }

    if (!(a.annotations || []).length && !drafts.length) {
      el.innerHTML = `<div class="art-hint"><span class="glyph">＋</span>
        <span>还没有标注</span><span>单击画面加编号，按住拖动框选；长按已有标注可改或删</span></div>`;
      return;
    }

    const delBtn = (id, title) =>
      `<button class="icon-btn n-del" data-del="${esc(id)}" title="${esc(title)}">✕</button>`;

    /* 严重度选择 + 说明输入，草稿和改写共用一套控件 */
    const composer = (id, severity, body, { saving, cancelLabel }) => `<span class="n-compose">
        <textarea rows="3" maxlength="800" ${saving ? 'disabled' : ''}
          placeholder="这块地方要改成什么？写给作者看的一句话就够"
          data-ctext="${esc(id)}">${esc(body)}</textarea>
        <span class="n-compose-bar">
          <span class="sev-pick" data-sev-for="${esc(id)}">${['blocker', 'major', 'minor'].map((s) =>
            `<button class="sev-opt${severity === s ? ' on' : ''}" ${saving ? 'disabled' : ''}
               data-sev-pick="${s}">${SEV_LABEL[s]}</button>`).join('')}</span>
          <button class="btn tiny ghost" ${saving ? 'disabled' : ''} data-cancel="${esc(id)}"
            >${cancelLabel}</button>
          <button class="btn tiny primary" ${saving ? 'disabled' : ''} data-save="${esc(id)}"
            >${saving ? '保存中…' : '保存说明'}</button>
        </span></span>`;

    const draftCard = (d) => `<div class="art-note draft${state.activeNoteId === d.key ? ' active' : ''}"
        data-id="${esc(d.key)}">
      <span class="n-head">
        <span class="n-seq" data-sev="${d.severity}">${d.seq}</span>
        <span class="n-sev" data-sev="${d.severity}">${SEV_LABEL[d.severity] || ''}</span>
        <span class="n-time">未提交</span>
        ${anchorTag({ anchor: d.anchor })}
        ${delBtn(d.key, '丢掉这条标注')}
      </span>
      ${composer(d.key, d.severity, d.body, { saving: !!d.saving, cancelLabel: '丢弃' })}
    </div>`;

    /* 已存的：点正文就地改写 */
    const card = (n) => {
      const editing = state.editingId === n.id;
      const body = esc(n.body || '（未填写说明）');
      if (n.resolved) {
        return `<div class="art-note resolved" data-id="${esc(n.id)}">
          <span class="n-head">
            <span class="n-seq" data-sev="${n.severity}">${n.seq}</span>
            <span class="n-body">${body}</span>
            <span class="n-time">${relTime(n.created_at)}</span>
            ${delBtn(n.id, '删除这条标注')}
          </span></div>`;
      }
      const tail = editing
        ? composer(n.id, state.editSeverity || n.severity,
                   state.edit ? state.edit.body : n.body,
                   { saving: false, cancelLabel: '取消' })
        : `<span class="n-body" data-edit="${esc(n.id)}" title="点击修改说明">${body}</span>`;
      return `<div class="art-note${state.activeNoteId === n.id ? ' active' : ''}" data-id="${esc(n.id)}">
          <span class="n-head">
            <span class="n-seq" data-sev="${n.severity}">${n.seq}</span>
            <span class="n-sev" data-sev="${n.severity}">${SEV_LABEL[n.severity] || ''}</span>
            <span class="n-time">${clockOf(n.created_at)}</span>
            ${anchorTag(n)}
            <button class="icon-btn" data-resolve="${esc(n.id)}" title="标记已解决">✓</button>
            ${delBtn(n.id, '删除这条标注')}
          </span>${tail}
        </div>`;
    };

    el.innerHTML = drafts.map(draftCard).join('') + open.map(card).join('') +
      (done.length ? `<div class="art-note-split">已解决 ${done.length}</div>` + done.map(card).join('') : '');
  }

  /* ------------------------------------------------------------ 版本链 / 对比 */
  const VERSION_STATUS = {
    pending: '待物化', ready: '就绪', reviewing: '评审中',
    approved: '通过', rework: '返工', rejected: '驳回',
  };

  async function loadChain(id) {
    if (!id) return;
    try {
      const data = await req('GET', `${API}/${id}/chain`);
      state.chain = data.chain || [];
      state.chainOf = id;
      if (state.diff && state.diff.to && state.diff.to.id !== id) state.diff = null;
      renderChain();
    } catch (err) {
      state.chain = [];
      renderChain();
    }
  }

  function renderChain() {
    const box = $('verChain');
    const a = current();
    const chain = state.chainOf === (a && a.id) ? state.chain : [];
    if (!a || chain.length < 2) {
      box.hidden = true;
      $('verDiff').hidden = true;
      return;
    }
    box.hidden = false;
    const chips = chain.map((v) => {
      const isCur = v.id === a.id;
      const isBase = v.id === state.diffBase;
      return `<button type="button" class="art-ver-chip"
        data-ver="${v.id}" data-current="${isCur ? 1 : 0}" data-base="${isBase ? 1 : 0}"
        title="${esc(v.title || '')} · ${VERSION_STATUS[v.status] || v.status} · ${clockOf(v.created_at || v.ts || '')}">
        <i class="art-ver-dot" data-status="${v.status}"></i>v${v.version}</button>`;
    }).join('');
    box.innerHTML = `<span class="art-ver-label">版本</span>${chips}
      <button type="button" class="art-ver-cmp" id="btnVerDiff">${state.diff ? '刷新对比' : '对比上版'}</button>`;
    $('btnVerDiff').addEventListener('click', () => {
      const prev = chain.filter((v) => v.id !== a.id).pop();
      loadDiff(prev ? prev.id : a.id);
    });
  }

  async function loadDiff(fromId) {
    const a = current();
    if (!a) return;
    state.diffBase = fromId;
    renderChain();
    try {
      const data = await req('GET', `${API}/${a.id}/diff?from=${encodeURIComponent(fromId)}`);
      state.diff = data.diff;
    } catch (err) {
      state.diff = null;
      toast('对比失败：' + err.message, 'err');
    }
    renderDiff();
  }

  function renderDiff() {
    const box = $('verDiff');
    const d = state.diff;
    if (!d) { box.hidden = true; return; }
    box.hidden = false;
    const same = d.from.id === d.to.id;
    const stat = (k, n, label) => (n ? `<span class="art-diff-stat" data-k="${k}">${label} ${n}</span>` : '');
    const group = (title, tone, notes) => (notes && notes.length
      ? `<div class="art-diff-group"><h5>${title}</h5>${notes
          .map((n) => `<div class="art-diff-note" data-tone="${tone}">#${n.seq} ${esc(n.body || '')}</div>`)
          .join('')}</div>` : '');
    const src = d.source && d.source.available
      ? `<div class="art-diff-group"><h5>源码差异</h5><div class="art-diff-code">${
          (d.source.hunks || []).map((line) => {
            const s = line.startsWith('+') ? 'add' : line.startsWith('-') ? 'del' : 'meta';
            return `<div data-s="${s}">${esc(line) || '&nbsp;'}</div>`;
          }).join('')}${d.source.truncated ? '<div data-s="meta">…差异过长已截断</div>' : ''}</div></div>`
      : '';

    box.innerHTML = `<div class="art-diff-head">
        <strong>${same ? '仅一个版本' : `v${d.from.version} → v${d.to.version}`}</strong>
        <span>${esc(VERSION_STATUS[d.from.status] || d.from.status)} → ${esc(VERSION_STATUS[d.to.status] || d.to.status)}</span>
        <button type="button" class="art-diff-close" id="btnDiffClose" title="收起">✕</button>
      </div>
      <div class="art-diff-stats">
        ${stat('resolved', d.counts.resolved, '已解决')}
        ${stat('kept', d.kept_open.length, '仍未解决')}
        ${stat('new', d.counts.fresh, '新增')}
        ${stat('dropped', d.counts.dropped, '丢失')}
      </div>
      ${group('这一版解决掉的', 'resolved', d.resolved)}
      ${group('还没解决的', 'kept', d.kept_open)}
      ${group('这版新提的', 'new', d.new_notes)}
      ${group('没被继承的意见', 'dropped', d.dropped_open)}
      ${src}`;
    const x = $('btnDiffClose');
    if (x) x.addEventListener('click', () => { state.diff = null; renderDiff(); });
  }

  /* ------------------------------------------------------------ 专注模式 */
  function setFocus(on) {
    state.focus = on;
    $('artBody').classList.toggle('focus', on);
    // 布局变化后必须重挂气泡位置（§4.6：不重置 SSE / 选中 / 草稿）
    requestAnimationFrame(renderOverlay);
  }

  /* ------------------------------------------------------------ 边栏折叠
     左右两栏各自独立收起，状态记在 localStorage：刷新后还在原来的样子。
     收起的只是那一栏的栅格列宽（0），舞台和另一栏照常可用；
     两个都收起就只剩舞台，切换入口在顶栏里，永远不会被一起收走。 */
  const SIDEBAR_KEY = 'pv.sidebars';
  function loadSidebars() {
    try {
      const v = JSON.parse(localStorage.getItem(SIDEBAR_KEY) || '{}');
      return { side: !!v.side, anno: !!v.anno };
    } catch (e) { return { side: false, anno: false }; }
  }
  function applySidebars() {
    const body = $('artBody');
    body.classList.toggle('no-side', state.sideCollapsed);
    body.classList.toggle('no-anno', state.annoCollapsed);
    const bs = $('btnSideToggle'); const ba = $('btnAnnoToggle');
    if (bs) {
      bs.classList.toggle('active', state.sideCollapsed);
      bs.setAttribute('aria-pressed', String(state.sideCollapsed));
      bs.title = state.sideCollapsed ? '展开左栏' : '收起左栏';
    }
    if (ba) {
      ba.classList.toggle('active', state.annoCollapsed);
      ba.setAttribute('aria-pressed', String(state.annoCollapsed));
      ba.title = state.annoCollapsed ? '展开标注栏' : '收起标注栏';
    }
  }
  function saveSidebars() {
    try {
      localStorage.setItem(SIDEBAR_KEY, JSON.stringify({
        side: !!state.sideCollapsed, anno: !!state.annoCollapsed }));
    } catch (e) { /* 无痕模式下写不进去就算了，本次会话内照常生效 */ }
  }
  function setSidebar(which, collapsed) {
    if (which === 'side') state.sideCollapsed = collapsed;
    else state.annoCollapsed = collapsed;
    applySidebars(); saveSidebars();
    /* 列宽变了，标注气泡的绝对坐标要跟着重算，不然会错位。 */
    requestAnimationFrame(renderOverlay);
  }

  /* ------------------------------------------------------------ 窄屏抽屉
   * CSS 已经把右栏画成底部抽屉、左栏画成全屏盖层，但两处状态类 .open /
   * .mobile-stage 之前没有任何代码去加 —— 规则写了等于没写。
   * 这里补上进入与退出两条路径，并且只在真的窄的时候生效，桌面行为不变。
   *
   * 这两条查询必须和 artifacts.css 的响应式段逐字对齐：CSS 画了抽屉而这里
   * 不认，抽屉就永远打不开（反过来也一样）。
   *
   * 平板为什么用「触摸设备 ≤1400」而不是纯宽度：
   *   纯宽度的话 iPad 一转屏就会从 834 跨到 1194、1024 跨到 1366，
   *   右侧栏在竖屏是常驻列、横屏变底部抽屉 —— 骨架整个换掉。
   *   改成按设备类别判定（触摸 = 一整类设备，无论横竖屏宽度多少），
   *   平板转屏就只是变宽变窄，布局不动；鼠标设备维持 1200 的纯宽度线，
   *   窄窗口照样降级抽屉，大窗口保持三栏。 */
  const NARROW_DRAWER = '(max-width: 1200px), (max-width: 1400px) and (any-pointer: coarse)';
  const NARROW_TREE = '(max-width: 699px)';
  const isNarrow = (q) => window.matchMedia(q).matches;

  function setAnnoDrawer(open) {
    $('artAnno').classList.toggle('open', open);
  }

  function syncNarrow() {
    // 回到桌面尺寸时把两个窄屏状态清掉，否则下次缩窄会带着旧状态进来
    if (!isNarrow(NARROW_DRAWER)) setAnnoDrawer(false);
    if (!isNarrow(NARROW_TREE)) $('artBody').classList.remove('mobile-stage');
  }

  /* ------------------------------------------------------------ 交互绑定 */
  function bind() {
    bindGate();
    bindSettings();
    $('btnTheme').addEventListener('click', toggleTheme);
    $('btnRefresh').addEventListener('click', () => { state.loading = true; renderTree(); loadList(); });
    $('btnFocus').addEventListener('click', () => setFocus(!state.focus));
    $('btnRestore').addEventListener('click', () => setFocus(false));
    /* 左右边栏折叠：读回上次状态 → 套用到栅格 → 绑顶栏两个按钮。
       必须在首次 renderStage 之前跑完，否则第一帧会按没收起的宽度画，闪一下。 */
    const sb0 = loadSidebars();
    state.sideCollapsed = sb0.side;
    state.annoCollapsed = sb0.anno;
    applySidebars();
    $('btnSideToggle').addEventListener('click', () => setSidebar('side', !state.sideCollapsed));
    $('btnAnnoToggle').addEventListener('click', () => setSidebar('anno', !state.annoCollapsed));

    $('btnLive').addEventListener('click', () => {
      // EventSource 自己会重连；这里给个手动兜底（页面被系统挂起过时）
      if (es && es.readyState === 1) { setLive('on'); loadList(); return; }
      connect();
    });
    $('btnBackStream').addEventListener('click', () => {
      $('artBody').classList.remove('mobile-stage');
    });
    /* 窄屏抽屉拉手：点标题栏展开/收起。桌面宽度下 .art-anno 是常驻栏，
       这时点标题栏没有意义，所以只在抽屉布局下才接管点击。 */
    $('artAnno').querySelector('.art-anno-head')
      .addEventListener('click', () => {
        if (!isNarrow(NARROW_DRAWER)) return;
        setAnnoDrawer(!$('artAnno').classList.contains('open'));
      });
    window.matchMedia(NARROW_DRAWER).addEventListener('change', syncNarrow);
    window.matchMedia(NARROW_TREE).addEventListener('change', syncNarrow);
    syncNarrow();

    $('verChain').addEventListener('click', (e) => {
      const chip = e.target.closest('[data-ver]');
      if (chip) loadDiff(chip.dataset.ver);
    });
    $('artFilters').addEventListener('click', (e) => {
      const b = e.target.closest('[data-kind]');
      if (!b) return;
      state.filter = b.dataset.kind;
      /* 筛选时把树全展开：用户找的是「某类型成果在哪」，折叠状态会把它藏起来 */
      state.filterCollapsed = state.filter !== 'all' || !!state.agent;
      renderFilters();
      renderTree();
      loadList();
    });

    $('artAgents').addEventListener('click', (e) => {
      if (e.target.closest('[data-agents-toggle]')) {
        state.agentsOpen = !state.agentsOpen;
        renderAgents();
        return;
      }
      const b = e.target.closest('[data-agent]');
      if (!b) return;
      state.agent = b.dataset.agent;
      state.filterCollapsed = state.filter !== 'all' || !!state.agent;
      renderAgents();          // 立刻高亮，不等网络回来
      renderTree();
      loadList();
    });

    /* 左栏目录树。折叠钮和成果行挤在同一个容器里，用 data 属性区分：
       先判折叠（点标题只展开/收起，不切换成果），再判成果。 */
    $('artTree').addEventListener('click', (e) => {
      const proj = e.target.closest('[data-toggle-project]');
      if (proj) {
        const key = proj.dataset.toggleProject;
        state.collapsed[key] = !state.collapsed[key];
        renderTree();
        return;
      }
      const sess = e.target.closest('[data-toggle-session]');
      if (sess) {
        const key = 's:' + sess.dataset.toggleSession;
        state.collapsed[key] = !state.collapsed[key];
        renderTree();
        return;
      }
      const vers = e.target.closest('[data-toggle-vers]');
      if (vers) {
        const key = 'v:' + vers.dataset.toggleVers;
        state.collapsed[key] = !state.collapsed[key];
        renderTree();
        return;
      }
      const c = e.target.closest('[data-id]');
      if (!c) return;
      select(c.dataset.id);
    });

    // 目录行是 div[role=treeitem]，需补键盘可达（Enter / Space）
    $('artTree').addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const c = e.target.closest('[data-id]');
      if (!c) return;
      e.preventDefault();
      select(c.dataset.id);
    });

    /* 右栏标注卡：解决 / 删除 / 写说明 / 改说明 / 点选定位
       —— 全走委托，列表每次都是整块 innerHTML 重画。
       草稿（data-c 开头的 key）和已存标注（真 id）在同一个委托里分流：
       前者只动本地，后者才发请求。 */
    $('annoList').addEventListener('click', (e) => {
      const a = current();
      if (!a) return;
      const draft = (id) => state.drafts.find((d) => d.key === id);

      const dl = e.target.closest('[data-del]');
      if (dl) {
        e.stopPropagation();
        const id = dl.dataset.del;
        /* 两步确认：第一次把 ✕ 换成红底「确认?」，2.6s 内没再按就还原。
           标注区一排 ✕ 挨着，一按就删太容易误伤。 */
        if (dl.dataset.armed !== '1') {
          dl.dataset.armed = '1';
          dl.textContent = '确认?';
          dl.classList.add('danger');
          clearTimeout(dl._arm);
          dl._arm = setTimeout(() => {
            if (!dl.isConnected) return;
            dl.dataset.armed = '0';
            dl.textContent = '✕';
            dl.classList.remove('danger');
          }, 2600);
          return;
        }
        if (draft(id)) dropDraft(id); else delNote(id);
        return;
      }

      const sv = e.target.closest('[data-sev-pick]');
      if (sv) {
        e.stopPropagation();
        const id = sv.closest('[data-sev-for]').dataset.sevFor;
        const d = draft(id);
        if (d) { d.severity = sv.dataset.sevPick; renderNotes(); renderOverlay(); return; }
        /* 正在改写这条：严重度跟着正文一起保存，不单独发请求 */
        if (state.editingId === id) { state.editSeverity = sv.dataset.sevPick; renderNotes(); return; }
        patchNote(id, { severity: sv.dataset.sevPick });
        return;
      }

      const sv2 = e.target.closest('[data-save]');
      if (sv2) {
        e.stopPropagation();
        const id = sv2.dataset.save;
        if (draft(id)) { saveDraft(id); return; }
        /* 改写已存标注：正文没动就别打扰服务器 */
        const n = a.annotations.find((x) => x.id === id);
        const body = (state.edit ? state.edit.body : '').trim();
        const sev = state.editSeverity || (n && n.severity);
        state.editingId = null;
        state.edit = null;
        renderNotes();
        if (n && body && body !== n.body) patchNote(id, { body, severity: sev });
        else if (n && sev !== n.severity) patchNote(id, { severity: sev });
        else renderOverlay();
        return;
      }

      const cx = e.target.closest('[data-cancel]');
      if (cx) {
        e.stopPropagation();
        const id = cx.dataset.cancel;
        if (draft(id)) { dropDraft(id); return; }        // 草稿只在前端，整条丢掉
        state.editingId = null;
        state.edit = null;
        renderNotes();
        renderOverlay();
        return;
      }

      const rs = e.target.closest('[data-resolve]');
      if (rs) {
        e.stopPropagation();
        const n = a.annotations.find((x) => x.id === rs.dataset.resolve);
        if (!n) return;
        const next = n.resolved ? 'open' : 'resolved';
        n.resolved = !n.resolved;                    // 乐观更新，失败再回滚
        if (state.editingId === n.id) { state.editingId = null; state.edit = null; }
        renderNotes(); renderTree(); renderOverlay();
        req('PATCH', `${API}/${a.id}/annotations/${n.id}`, { status: next })
          .catch((err) => {
            n.resolved = !n.resolved;
            toast(`标注状态没存上：${err.message || err}`, 'warn');
            renderNotes(); renderTree(); renderOverlay();
          });
        return;
      }

      /* 点说明正文 → 就地改写它 */
      const ed = e.target.closest('[data-edit]');
      if (ed) {
        e.stopPropagation();
        const n = a.annotations.find((x) => x.id === ed.dataset.edit);
        if (!n) return;
        state.editingId = n.id;
        state.activeNoteId = n.id;
        state.edit = { body: n.body || '' };
        state.editSeverity = n.severity;
        renderNotes();
        const ta = $('annoList').querySelector(`.art-note[data-id="${n.id}"] [data-ctext]`);
        if (ta) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }
        return;
      }

      const c = e.target.closest('[data-id]');
      if (!c) return;
      state.activeNoteId = c.dataset.id;
      focusNote(c.dataset.id, { pulse: true });
    });

    /* 说明输入：草稿直接改本地并重画画面上的悬停说明；已存标注先攒在 state.edit */
    $('annoList').addEventListener('input', (e) => {
      const ta = e.target.closest('[data-ctext]');
      if (!ta) return;
      const id = ta.dataset.ctext;
      const d = state.drafts.find((x) => x.key === id);
      if (d) { d.body = ta.value; renderOverlayThrottled(); return; }
      state.edit = { body: ta.value };
      renderOverlayThrottled();
    });

    $('annoList').addEventListener('keydown', (e) => {
      const ta = e.target.closest('[data-ctext]');
      if (!ta) return;
      const box = ta.closest('.n-compose');
      if (!box) return;
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault(); e.stopPropagation();
        box.querySelector('[data-save]').click();
      }
      if (e.key === 'Escape') {
        e.stopPropagation();
        box.querySelector('[data-cancel]').click();
      }
    });

    /* 草稿说明越写越长，画面上那块悬停气泡要跟着变；一个字重画一次太浪费，
       攒 120ms 一次，肉眼无差别。 */
    let ovTimer = null;
    function renderOverlayThrottled() {
      if (ovTimer) return;
      ovTimer = setTimeout(() => { ovTimer = null; renderOverlay(); }, 120);
    }

    // 舞台标注 → 右栏卡高亮
    $('stage').addEventListener('click', (e) => {
      const b = e.target.closest('.art-box, .art-pin');
      if (!b) return;
      state.activeNoteId = b.dataset.id;
      focusNote(b.dataset.id);
    });

    /* 标注方式切换：单选，再按一次同一个 = 收起工具 */
    $('annoModes').addEventListener('click', (e) => {
      const b = e.target.closest('[data-note-mode]');
      if (!b || !current()) return;
      setNoteMode(b.dataset.noteMode, { toggle: true });
      toast(state.noteArmed
        ? (state.noteMode === 'box' ? '按住拖动，框一块区域' : '点一下画面，落一个编号')
        : '已收起标注工具', 'info');
    });

    /* 落标注手势挂在 #stage 上，不是 #overlay ——
       overlay 是 renderStage() 每次重画才换掉的新节点，bind() 时它还不存在，
       早先挂上去的监听全部落空，表现就是「点了没反应」。 */
    const stage = $('stage');
    bindDraw();

    /* 「确认提交」= 把这一轮的意见交给 agent 按内容去改。
       走 /apply：它同时管原项目目录、对应会话、唤醒 agent 三条通道，
       比单发 /dispatch 全，所以「提交」只用这一个入口。 */
    $('btnSubmit').addEventListener('click', async () => {
      const a = current();
      if (!a) return;
      const btn = $('btnSubmit');
      state.applying = true;
      btn.disabled = true;
      btn.textContent = '提交中…';
      try {
        /* 草稿只活在前端。直接提交等于把没写完的话咽回去，
           所以先存后交，存不下来的明说，别假装交成功了。 */
        const left = await flushDrafts();
        if (left) {
          toast(`还有 ${left} 条标注没写完说明，补上再提交`, 'warn');
          return;
        }
        const r = await req('POST', `${API}/${a.id}/apply`, {});
        showApplyResult(r);
        if (r.ok) await loadOne(a.id);
        else toast('没送出去，下面哪条通道标红就查那条', 'warn');
      } catch (err) {
        toast(`提交失败：${err.message || err}`, 'warn');
      } finally {
        state.applying = false;
        renderNotes();
      }
    });

    /* 「继续编辑」= 先不提交，回到继续标的状态。
       它不发任何请求：草稿原地留着，标注工具重新架起来，接着标就行。
       这个键以前叫「应用 AI 修改」，名实不符，是「按键无效」观感的另一半。 */
    const btnKeepEditing = $('btnApply');
    if (btnKeepEditing) btnKeepEditing.addEventListener('click', () => {
      const a = current();
      if (!a) return;
      if (!state.noteArmed) setNoteMode(state.noteMode || 'point');
      state.activeNoteId = null;
      renderNotes(); renderOverlay();
      toast(state.drafts.length
        ? `继续标：${state.drafts.length} 条草稿还在，写完说明再点「确认提交」`
        : '继续标，选中成果和已写的意见都不会丢', 'info');
    });

    $('btnApprove').addEventListener('click', () => setStatus('approved'));
    /* 下载：走 blob 而不是直接开 raw 地址 —— 直接跳转只会把内容显示在
       浏览器里，不会落盘，用户以为按钮坏了。 */
    $('btnDownload').addEventListener('click', async () => {
      const a = current();
      if (!a || !a.src) return;
      try {
        const res = await fetch(a.src, { credentials: 'same-origin' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = a.file_name || a.title || 'artifact';
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 20000);
      } catch (err) {
        toast(`下载失败：${err.message || err}`, 'warn');
      }
    });
    /* 后端只认 pending/ready/reviewing/approved/rework/rejected，
       之前发的 changes_requested 会被 400 打回，乐观更新再回滚，
       看起来就是"驳回没反应"。 */
    $('btnReject').addEventListener('click', () => setStatus('rework'));

    $('stageModes').addEventListener('click', (e) => {
      const b = e.target.closest('[data-mode]');
      if (!b) return;
      $('stageModes').querySelectorAll('button').forEach((x) => x.classList.toggle('active', x === b));
      state.mode = b.dataset.mode;
      renderStage();                                  // 换渲染源，坐标体系随之切换
      renderOverlay();
    });

    /* 部件树：点在哪个树上就只渲染哪个部件 */
    document.addEventListener('click', (e) => {
      const p = e.target.closest && e.target.closest('[data-part]');
      if (p) selectPart(p.dataset.part);
    });

    /* 桌面端没有长按，右键走同一套菜单 */
    document.addEventListener('contextmenu', (e) => {
      const mark = e.target.closest && e.target.closest('.art-box, .art-pin');
      if (!mark || !mark.dataset.id) return;
      e.preventDefault();
      openNoteMenu(mark.dataset.id, e.clientX, e.clientY);
    });

    /* 需求 4：就地编辑 */
    const btnEdit = $('btnEdit');
    if (btnEdit) btnEdit.addEventListener('click', toggleTextEdit);

    document.addEventListener('keydown', (e) => {
      const typing = /^(INPUT|TEXTAREA)$/.test(document.activeElement && document.activeElement.tagName);
      if (typing) return;
      if (e.key === 'f' || e.key === 'F') { setFocus(!state.focus); return; }
      /* Esc 一级一级退：先收说明编辑器，再收标注工具，最后收右栏。
         一个键管一件正在做的事，不会一按就把整个面板都关掉。 */
      if (e.key === 'Escape') {
        if (state.editingId) { state.editingId = null; state.edit = null; renderNotes(); return; }
        /* Escape 只退掉「正在写的那一条」，不要一锅端。
           用户最常见的动作就是长按刚点出来的标注 → 挑个菜单项，
           中途手滑按一下 Escape，结果草稿全没了 —— 那不是取消，是删数据。
           菜单开着的时候也先关菜单，别连带把标注丢掉。 */
        if (menuEl) { closeNoteMenu(); return; }
        const activeDraft = state.drafts.find((d) => d.key === state.activeNoteId)
          || state.drafts[state.drafts.length - 1];
        if (activeDraft) {
          state.drafts = state.drafts.filter((d) => d.key !== activeDraft.key);
          state.activeNoteId = null;
          renderNotes(); renderOverlay();
          return;
        }
        if (noteArmed()) { setNoteMode(state.noteMode, { toggle: true }); return; }
        return;
      }
      /* 删掉正在看的那条标注：比举着鼠标去点 ✕ 快，也省掉二次确认那一下 */
      if ((e.key === 'Delete' || e.key === 'Backspace') && state.activeNoteId
          && document.activeElement === document.body) {
        e.preventDefault();
        const id = state.activeNoteId;
        if (state.drafts.some((d) => d.key === id)) dropDraft(id); else delNote(id);
        return;
      }
      const m = { 1: 'point', 2: 'box' }[e.key];
      if (m && current()) setNoteMode(m, { toggle: true });
    });

    window.addEventListener('resize', () => requestAnimationFrame(renderOverlay));
  }

  async function setStatus(s) {
    const a = current();
    if (!a) return;
    const prev = a.status;
    a.status = s;                                     // 乐观更新
    renderTree();
    renderStage();
    try {
      await req('POST', `${API}/${a.id}/status`, { status: s });
      toast(s === 'approved' ? '已标记通过' : '已退回返工', 'ok');
    } catch (err) {
      a.status = prev;
      renderTree();
      renderStage();
      toast(`状态没存上：${err.message || err}`, 'warn');
    }
  }

  function select(id) {
    state.selectedId = id;
    state.chain = [];
    state.chainOf = '';
    state.diff = null;
    const a = current();
    state.activeNoteId = null;                       // 换成果就换一套标注上下文
    state.drafts = [];
    state.editingId = null;
    state.edit = null;
    state.partId = '';
    state.parts = null;
    state.editText = false;
    state.textDirty = false;
    state.textBase = '';
    state.textDraft = '';
    /* 窄屏：选完就把全屏盖着的左栏收起来看舞台（≤768px 才生效）。
       没这一步，左栏在手机上是 100% 宽的固定盖层，点完成果什么也不会发生。 */
    if (isNarrow(NARROW_TREE)) {
      $('artBody').classList.add('mobile-stage');
      setAnnoDrawer(false);
    }
    renderTree();
    renderStage();
    renderNotes();
    renderChain();
    syncModeButtons();
    if (a && !a._loaded) loadOne(id);      // 标注只在单条接口里，选中就补拉
    loadChain(id);                         // 版本链决定要不要显示版本条
    if (a) loadParts(a).then(() => {        // 部件树要一次请求，回来再补画竖排树
      if (state.selectedId === id) renderStage();
    });
  }

  function setLive(s) {
    const b = $('btnLive');
    b.dataset.state = s;
    $('liveLabel').textContent = { on: '实时', connecting: '连接中', off: '未连接' }[s];
  }

  function renderAll() {
    renderFilters();
    renderAgents();
    renderTree();
    renderStage();
    renderNotes();
    renderChain();
    renderDiff();
    syncModeButtons();
  }

  /* 启动 */
  applyTheme();
  bind();
  renderFilters();
  renderAgents();
  renderTree();
  syncModeButtons();
  connect();                                         // SSE 先起来，别等首屏列表
  loadList().then(ensureSelection);                  // 拉完真列表再落默认选中

  window.artifactsApi = { loadList, connect, state };   // 冒烟脚本用
})();