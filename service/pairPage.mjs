// 网关上的「扫码连接」页面（零依赖，单文件 HTML）。
//
// 为什么放在网关而不是上游 React 前端里：这张页面要给手机扫码，它必须由
// 手机真正会连的那个入口（网关 5186，HTTPS）提供；改 vendored 上游 UI 组件
// 既要重打包又容易在下次同步上游时丢掉。页面只用 /api/pilotv/pair/*，
// 与上游 UI 无关。
export function renderPairPage({ device = '', deviceName = '' } = {}) {
  // 把「这台入口当前指向哪台设备」注入页面：多设备部署时，手机没有 Cookie，
  // 网关只能按请求头/查询参数决定去哪台。不绑定的话，手机连上的是默认设备，
  // 而用户是在另一台的页面上扫的码 —— 现象是「扫完 401」，非常难查。
  const runtime = `<script>window.__PILOTV_DEVICE__=${JSON.stringify(device)};window.__PILOTV_DEVICE_NAME__=${JSON.stringify(deviceName)};</script>`;
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>PilotV · 扫码连接手机</title>
${runtime}
<style>
  :root { color-scheme: dark; --bg:#0A0A0A; --panel:#141414; --line:#262626; --text:#F5F5F5; --dim:#8C8C8C; --orange:#E55A09; --blue:#297CC0; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--text); font:15px/1.6 -apple-system, "Segoe UI", "PingFang SC", "Noto Sans SC", sans-serif; }
  .wrap { max-width: 880px; margin: 0 auto; padding: 40px 24px 64px; }
  header { display:flex; align-items:center; gap:12px; margin-bottom: 28px; }
  .mark { width:34px; height:34px; border-radius:9px; background:linear-gradient(180deg,#151515,#0d0d0d); display:grid; place-items:center; border:1px solid var(--line); }
  .mark svg { width:20px; height:20px; }
  h1 { font-size: 20px; margin:0; letter-spacing:.2px; }
  .sub { color:var(--dim); font-size: 13px; }
  .grid { display:grid; grid-template-columns: minmax(0,320px) minmax(0,1fr); gap: 28px; align-items:start; }
  @media (max-width: 760px) { .grid { grid-template-columns: 1fr; } }
  .card { background:var(--panel); border:1px solid var(--line); border-radius:16px; padding:22px; }
  .qrbox { background:#fff; border-radius:12px; padding:12px; display:grid; place-items:center; min-height: 296px; }
  .qrbox img { width: 100%; height:auto; display:block; image-rendering: pixelated; }
  .code { font: 600 30px/1.2 ui-monospace, "SF Mono", Menlo, monospace; letter-spacing: 6px; text-align:center; margin-top:14px; }
  .meta { display:flex; justify-content:space-between; color:var(--dim); font-size:12.5px; margin-top:10px; }
  button { font: inherit; border-radius:10px; border:1px solid var(--line); background:#1b1b1b; color:var(--text); padding:10px 16px; cursor:pointer; }
  button.primary { background:var(--orange); border-color:transparent; color:#fff; font-weight:600; }
  button:disabled { opacity:.5; cursor: default; }
  ol { padding-left: 20px; margin: 0; }
  ol li { margin-bottom: 10px; color:#D4D4D4; }
  .steps { color: var(--dim); font-size:13px; border-left:2px solid var(--blue); padding-left:14px; }
  .devices { margin-top: 26px; }
  .device { display:flex; justify-content:space-between; gap:12px; padding:12px 0; border-top:1px solid var(--line); font-size:13.5px; }
  .device:first-of-type { border-top:0; }
  .badge { font-size:11.5px; color:#9CE0B4; border:1px solid #23553a; background:#10241a; border-radius:999px; padding:2px 9px; height:fit-content; }
  .err { color:#ff9d9d; font-size:13px; margin-top:12px; min-height:18px; }
  .hint { color:var(--dim); font-size:12.5px; margin-top:16px; }
  a { color: var(--blue); text-decoration: none; }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <div class="mark">
      <svg viewBox="0 0 512 512" aria-hidden="true"><path d="M400 30 240 30 40 470 200 470Z" fill="#E55A09"/><rect x="150" y="400" width="290" height="26" rx="13" fill="#297CC0"/></svg>
    </div>
    <div>
      <h1>扫码连接手机 / 平板</h1>
      <div class="sub" id="hostline">—</div>
      <div class="sub" id="deviceline" style="margin-top:2px"></div>
    </div>
  </header>

  <div class="grid">
    <div class="card">
      <div class="qrbox" id="qrbox"><span style="color:#888;font-size:13px">正在生成二维码…</span></div>
      <div class="code" id="code">······</div>
      <div class="meta"><span>5 分钟内有效 · 仅可兑换一次</span><span id="countdown">—</span></div>
      <div style="display:flex;gap:10px;margin-top:16px">
        <button class="primary" id="renew">刷新二维码</button>
        <button id="copy">复制连接串</button>
      </div>
      <div class="err" id="err"></div>
    </div>

    <div>
      <div class="card">
        <div class="steps">
          <ol>
            <li>打开 PilotV 安卓客户端，点「扫码连接」。</li>
            <li>对准左边二维码；首次连接会显示证书指纹，核对后点「信任并连接」。</li>
            <li>连上后随时收发会话、处理授权、看成果 —— 不需要开着 Tailscale。</li>
          </ol>
          <div class="hint" id="altline" style="display:none"></div>
          <div class="hint">
            手输也算数：在客户端里输入设备地址 <code id="addr">—</code> 与上方 6 位码 + 连接串里的密钥，
            或直接粘贴「复制连接串」得到的内容。
          </div>
        </div>
      </div>
      <div class="card devices" style="margin-top:18px">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <strong style="font-size:14px">已配对设备</strong>
          <span class="sub" id="devicecount">—</span>
        </div>
        <div id="devicelist" style="margin-top:8px"></div>
      </div>
    </div>
  </div>
</div>
<script>
(() => {
  const $ = (id) => document.getElementById(id);
  let current = null;
  let timer = null;

  const b64url = (text) => {
    const bytes = new TextEncoder().encode(text);
    let bin = '';
    for (const byte of bytes) bin += String.fromCharCode(byte);
    return btoa(bin).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '');
  };

  async function api(pathname, options = {}) {
    const response = await fetch(pathname, {
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', ...(options.headers || {}) },
      ...options,
    });
    const isJson = (response.headers.get('content-type') || '').includes('json');
    const payload = isJson ? await response.json() : await response.text();
    if (!response.ok) {
      const message = (payload && payload.error) || ('HTTP ' + response.status);
      const error = new Error(message);
      error.status = response.status;
      error.payload = payload;
      throw error;
    }
    return payload;
  }

  function tick() {
    if (!current) return;
    const left = Math.max(0, Math.round((current.expiresAt - Date.now()) / 1000));
    const mm = String(Math.floor(left / 60)).padStart(2, '0');
    const ss = String(left % 60).padStart(2, '0');
    $('countdown').textContent = left > 0 ? mm + ':' + ss + ' 后过期' : '已过期';
    if (left === 0) {
      clearInterval(timer);
      $('err').textContent = '二维码已过期，点「刷新二维码」重新生成。';
    }
  }

  async function issue() {
    $('err').textContent = '';
    $('code').textContent = '······';
    $('qrbox').innerHTML = '<span style="color:#888;font-size:13px">正在生成二维码…</span>';
    try {
      const data = await api('/api/pilotv/pair/new', {
        method: 'POST',
        body: JSON.stringify({ origin: location.origin, deviceOrigin: window.__PILOTV_DEVICE__ || '' }),
      });
      current = { ...data, expiresAt: Date.parse(data.expiresAt) };
      $('code').textContent = data.code;
      $('addr').textContent = data.origin;
      // 二维码里同时带了备用入口（局域网 / 公网隧道），客户端会逐个试连。
      // 这里显式列出来，否则用户看到「手机连上了」也不知道走的是哪条路。
      const alts = Array.isArray(data.alternates) ? data.alternates : [];
      const altline = $('altline');
      if (alts.length) {
        altline.textContent = '备用入口：' + alts.join('   ·   ') + '（局域网优先，连不上自动走另一个）';
        altline.style.display = '';
      } else {
        altline.style.display = 'none';
      }
      const img = document.createElement('img');
      img.alt = '配对二维码';
      img.src = '/api/pilotv/pair/render.svg?d=' + b64url(data.uri);
      $('qrbox').innerHTML = '';
      $('qrbox').appendChild(img);
      clearInterval(timer);
      tick();
      timer = setInterval(tick, 1000);
      poll();
    } catch (error) {
      if (error.status === 401) {
        $('err').innerHTML = '需要先在这个浏览器里<a href="/">登录 PilotV</a>，再回来生成二维码。';
      } else {
        $('err').textContent = error.message;
      }
    }
  }

  async function poll() {
    if (!current) return;
    try {
      const state = await api('/api/pilotv/pair/status?code=' + encodeURIComponent(current.code));
      if (state.state === 'used') {
        clearInterval(timer);
        $('err').textContent = '这台设备已经配对成功，可以关掉这个页面了。';
        loadDevices();
        setTimeout(issue, 2500);
        return;
      }
    } catch { /* 轮询失败不打扰用户，下一次继续 */ }
    if (current) setTimeout(poll, 2500);
  }

  async function loadDevices() {
    try {
      const data = await api('/api/pilotv/pair/devices');
      const list = $('devicelist');
      $('devicecount').textContent = data.devices.length + ' 台';
      list.innerHTML = '';
      if (!data.devices.length) {
        list.innerHTML = '<div class="sub" style="padding:10px 0">还没有设备。手机上扫一次码就会出现。</div>';
        return;
      }
      for (const device of data.devices) {
        const row = document.createElement('div');
        row.className = 'device';
        const left = document.createElement('div');
        left.innerHTML = '<div>' + device.name + '</div><div class="sub">' + device.platform + ' · ' + device.origin + '</div>';
        const right = document.createElement('div');
        right.style.display = 'flex';
        right.style.gap = '10px';
        right.style.alignItems = 'center';
        const badge = document.createElement('span');
        badge.className = 'badge';
        badge.textContent = '已配对';
        const del = document.createElement('button');
        del.textContent = '移除';
        del.style.padding = '5px 10px';
        del.style.fontSize = '12px';
        del.onclick = async () => {
          await api('/api/pilotv/pair/devices/' + encodeURIComponent(device.id), { method: 'DELETE' });
          loadDevices();
        };
        right.append(badge, del);
        row.append(left, right);
        list.appendChild(row);
      }
    } catch (error) {
      $('devicelist').textContent = '读取设备列表失败：' + error.message;
    }
  }

  $('renew').onclick = issue;
  $('copy').onclick = async () => {
    if (!current) return;
    try {
      await navigator.clipboard.writeText(current.uri);
      $('copy').textContent = '已复制';
      setTimeout(() => { $('copy').textContent = '复制连接串'; }, 1600);
    } catch {
      $('err').textContent = '复制失败，请手动选择连接串。';
    }
  };
  $('hostline').textContent = location.origin;
  $('deviceline').textContent = window.__PILOTV_DEVICE__
    ? '指向设备：' + (window.__PILOTV_DEVICE_NAME__ || window.__PILOTV_DEVICE__)
    : '指向设备：默认设备';
  issue();
  loadDevices();
})();
</script>
</body>
</html>`;
}

export default renderPairPage;
