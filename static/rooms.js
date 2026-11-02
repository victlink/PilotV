/* PilotV 项目室 —— 独立静态页。
 *
 * 安全约定（改这个文件时不要破坏）：
 *   1. 所有来自服务器/用户的文本一律走 textContent，绝不 innerHTML。
 *      房间消息是 agent 写的自由文本，@成员 后面可能带 <script>。
 *   2. 链接只允许 http/https 和站内相对路径，javascript: 一律拒绝。
 *   3. 令牌只放在内存里，不写 localStorage / cookie，也不上 URL。
 */

const $ = (id) => document.getElementById(id);
const API = '/api/artifacts/rooms';

let room = null;          // 当前房间 id
let members = [];         // 当前房间成员
let stream = null;        // SSE
let revision = 0;         // 切房间时自增，丢弃过期的异步结果
let refreshing = false;
let pendingSend = null;   // 同一条消息重试时复用同一个幂等键

function showError(err) {
  const box = $('error');
  const text = String((err && err.message) || err || '');
  if (!text) { box.hidden = true; box.textContent = ''; return; }
  box.hidden = false;
  box.textContent = text;
}

function clearError() { showError(''); }

async function api(path, options) {
  const opt = options || {};
  const init = {
    method: opt.method || 'GET',
    credentials: 'same-origin',
    headers: {},
    cache: 'no-store',
  };
  if (opt.body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(opt.body);
  }
  if (opt.token) init.headers['X-Artifacts-Token'] = opt.token;
  const resp = await fetch(API + path, init);
  if (!resp.ok) {
    let detail = '';
    try { detail = (await resp.text()).slice(0, 300); } catch (e) { /* 忽略 */ }
    let msg = `请求失败 ${resp.status}`;
    if (resp.status === 401 || resp.status === 403) {
      msg = '未通过鉴权：请在 PilotV 里登录后再打开本页（回环直连时需要带令牌）。';
    } else if (detail) {
      msg += `：${detail}`;
    }
    throw new Error(msg);
  }
  return resp.json();
}

/** 安全链接：只允许 http/https 与站内相对路径。 */
function safeHref(raw) {
  const value = String(raw || '').trim();
  if (!value) return null;
  if (/^https?:\/\//i.test(value)) return value;
  if (value.startsWith('/') && !value.startsWith('//')) return value;
  return null;
}

/** 把正文里的成果链接变成可点元素。其余文本一律 textContent。 */
function renderText(target, text) {
  const raw = String(text || '');
  const pattern = /(https?:\/\/[^\s<>"']+|\/api\/artifacts\/art_[0-9a-f]+)/gi;
  let last = 0;
  let match;
  while ((match = pattern.exec(raw)) !== null) {
    if (match.index > last) {
      target.appendChild(document.createTextNode(raw.slice(last, match.index)));
    }
    const href = safeHref(match[0]);
    if (href) {
      const a = document.createElement('a');
      a.href = href;
      a.textContent = match[0];
      a.rel = 'noopener noreferrer';
      a.target = '_blank';
      target.appendChild(a);
    } else {
      target.appendChild(document.createTextNode(match[0]));
    }
    last = match.index + match[0].length;
  }
  if (last < raw.length) target.appendChild(document.createTextNode(raw.slice(last)));
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

async function loadRooms() {
  const data = await api('');
  const box = $('rooms');
  box.replaceChildren();
  $('rooms-empty').hidden = (data.rooms || []).length > 0;
  for (const r of data.rooms || []) {
    const b = el('button', 'room-button');
    b.type = 'button';
    b.setAttribute('role', 'listitem');
    b.textContent = r.name;
    if (r.id === room) b.classList.add('current');
    b.onclick = () => select(r.id).catch(showError);
    box.appendChild(b);
  }
  return data.rooms || [];
}

function renderMembers() {
  const list = $('members');
  list.replaceChildren();
  $('members-empty').hidden = members.length > 0;
  for (const m of members) {
    const li = el('li', 'member');
    li.appendChild(el('span', 'member-name', '@' + m.display_name));
    li.appendChild(el('span', 'badge', m.role));
    li.appendChild(el('code', 'muted', m.session_key || '（无会话）'));
    const remove = el('button', 'link', '移除');
    remove.type = 'button';
    remove.onclick = () => removeMember(m).catch(showError);
    li.appendChild(remove);
    list.appendChild(li);
  }
  const names = members.map((m) => '@' + m.display_name).join('、');
  $('mention-hint').textContent = names ? `可寻址：${names}` : '';
}

/** 拉全量转录。游标用 seq，不用条数：房间里可能正有人在发言。 */
async function loadTranscript() {
  if (!room || refreshing) return;
  refreshing = true;
  const id = room;
  const rev = revision;
  try {
    let cursor = 0;
    const all = [];
    let more = true;
    while (more) {
      const data = await api(`/${encodeURIComponent(id)}/messages?after_seq=${cursor}&limit=200`);
      all.push(...(data.messages || []));
      more = !!data.has_more;
      if (more && data.next_seq <= cursor) throw new Error('分页游标没有前进，已停止翻页');
      cursor = data.next_seq;
    }
    if (rev !== revision || id !== room) return;
    const box = $('messages');
    const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
    box.replaceChildren();
    $('messages-empty').hidden = all.length > 0;
    for (const m of all) box.appendChild(renderMessage(m));
    if (nearBottom) box.scrollTop = box.scrollHeight;
  } finally {
    refreshing = false;
  }
}

function renderMessage(m) {
  const article = el('article', 'message');
  article.dataset.seq = String(m.seq);
  const meta = el('small', 'meta');
  meta.textContent = `#${m.seq} · ${m.author || m.role} · ${m.role} · ${m.at || ''} · 来源 ${m.source || '?'}`;
  article.appendChild(meta);
  const body = el('p', 'body');
  renderText(body, m.text);
  article.appendChild(body);
  const status = el('small', 'delivery');
  const list = m.deliveries || [];
  if (!list.length) {
    status.textContent = '无自动投递（没有 @ 接收者，或策略为 off）';
  } else {
    status.textContent = list
      .map((d) => `${d.display_name || d.member_id}：${d.state}${d.reason ? '（' + d.reason + '）' : ''}`)
      .join('　|　');
  }
  article.appendChild(status);
  return article;
}

async function select(id) {
  revision += 1;
  room = id;
  if (stream) { stream.close(); stream = null; }
  const data = await api('/' + encodeURIComponent(id));
  members = data.members || [];
  $('title').textContent = data.room.name;
  $('room-id').textContent = data.room.id;
  $('bulletin').textContent = data.room.bulletin || '';
  $('room-empty').hidden = true;
  $('room-detail').hidden = false;
  renderMembers();
  await loadRooms();
  await loadTranscript();
  connectStream(id);
}

function connectStream(id) {
  if (stream) stream.close();
  stream = new EventSource(`${API}/${encodeURIComponent(id)}/events`);
  stream.onopen = () => {
    $('connection').textContent = '实时连接已建立';
    $('connection').dataset.state = 'live';
    loadTranscript().catch(showError);
  };
  stream.onerror = () => {
    $('connection').textContent = '实时连接中断，正在自动重连（并有定时刷新保底）';
    $('connection').dataset.state = 'down';
  };
  for (const name of ['room.message', 'room.delivery']) {
    stream.addEventListener(name, () => loadTranscript().catch(showError));
  }
}

async function removeMember(m) {
  if (!room) return;
  await api(`/${encodeURIComponent(room)}/members/${encodeURIComponent(m.member_id)}`, { method: 'DELETE' });
  await select(room);
}

function onForm(id, handler) {
  $(id).onsubmit = async (event) => {
    event.preventDefault();
    clearError();
    const button = event.target.querySelector('button[type=submit]');
    const label = button ? button.textContent : '';
    if (button) { button.disabled = true; button.textContent = '处理中…'; }
    try {
      await handler(Object.fromEntries(new FormData(event.target)));
    } catch (err) {
      showError(err);
    } finally {
      if (button) { button.disabled = false; button.textContent = label; }
    }
  };
}

onForm('create', async (data) => {
  const out = await api('', {
    method: 'POST',
    body: {
      name: data.name,
      bulletin: data.bulletin || '',
      respond_policy: data.respond_policy || 'mentions',
    },
  });
  $('create').reset();
  await loadRooms();
  await select(out.room.id);
});

onForm('member', async (data) => {
  if (!room) throw new Error('请先选一个房间');
  const body = {
    display_name: data.display_name,
    role: data.role,
    session_key: (data.session_key || '').trim(),
    model: (data.model || '').trim(),
  };
  if (!body.session_key) delete body.session_key;
  if (!body.model) delete body.model;
  await api(`/${encodeURIComponent(room)}/members`, { method: 'POST', body });
  $('member').reset();
  await select(room);
});

onForm('send', async (data) => {
  if (!room) throw new Error('请先选一个房间');
  const signature = JSON.stringify([room, data.author, data.text]);
  // 幂等键：同一条消息重试（网络抖动、按钮连点）只落一条。
  if (!pendingSend || pendingSend.signature !== signature) {
    pendingSend = { signature, key: crypto.randomUUID() };
  }
  await api(`/${encodeURIComponent(room)}/messages`, {
    method: 'POST',
    body: {
      text: data.text,
      author: data.author,
      role: 'user',
      source: 'human',
      idempotency_key: pendingSend.key,
    },
  });
  pendingSend = null;
  $('send').elements.text.value = '';
  await loadTranscript();
});

$('refresh').onclick = () => loadRooms().then(() => (room ? select(room) : null)).catch(showError);

// 实时连接断了也要能继续读：定时拉一次。
setInterval(() => loadTranscript().catch(showError), 10000);

loadRooms()
  .then(() => {
    $('connection').textContent = '就绪';
    $('connection').dataset.state = 'live';
  })
  .catch(showError);
