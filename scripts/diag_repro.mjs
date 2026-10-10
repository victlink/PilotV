/**
 * 复现用户报的四个问题（只诊断，不改代码）：
 *   1. 选中会话后左栏仍然列出很多内容
 *   2. 界面文字/按键重叠、布局错乱
 *   3. 长按拖动框选与浏览器原生操作冲突
 *   4. 「应用 AI 修改」「提交返工」两个按键无效且语义有歧义
 *
 * 用法：node scripts/diag_repro.mjs <pageUrl>
 * 环境由 scripts/diag_repro.sh 起（隔离数据目录 + 隔离 PilotDeck 家目录 + 假会话树）。
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const SRC = process.env.PILOTDECK_SRC || "/home/Marc/PilotDeck-src";
const PAGE_URL = process.argv[2] || "http://127.0.0.1:8899/artifacts.html";
const API = new URL(PAGE_URL).origin;
const CDP_PORT = Number(process.env.CDP_PORT || 9411);
const ROOT = new URL("..", import.meta.url).pathname;
const SHOT_DIR = path.join(ROOT, ".artifacts-data", "diag");
mkdirSync(SHOT_DIR, { recursive: true });

const { default: WebSocket } = await import(pathToFileURL(`${SRC}/node_modules/ws/wrapper.mjs`).href);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const S = (t) => console.log(`\n\x1b[1m===== ${t} =====\x1b[0m`);

function findChrome() {
  const base = path.join(homedir(), ".cache", "ms-playwright");
  let cands = [];
  try {
    cands = readdirSync(base).filter((d) => d.startsWith("chromium")).map((d) =>
      path.join(base, d, "chrome-linux64", "chrome"));
  } catch { /* 没有就靠 CHROME_PATH */ }
  const found = cands.filter((p) => existsSync(p)).pop();
  if (found) return found;
  if (process.env.CHROME_PATH && existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  throw new Error("找不到 Chromium");
}

class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.waits = new Map(); this.events = []; }
  static async connect(url) {
    const ws = new WebSocket(url, { maxPayload: 256 * 1024 * 1024 });
    await new Promise((res, rej) => { ws.once("open", res); ws.once("error", rej); });
    const c = new Cdp(ws);
    ws.on("message", (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.id && c.waits.has(m.id)) {
        const { res, rej } = c.waits.get(m.id); c.waits.delete(m.id);
        m.error ? rej(new Error(m.error.message)) : res(m.result);
      } else if (m.method) c.events.push(m);
    });
    return c;
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.waits.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      setTimeout(() => { if (this.waits.has(id)) { this.waits.delete(id); rej(new Error(`${method} 超时`)); } }, 30000);
    });
  }
}

async function evalJs(cdp, sid, expr) {
  const r = await cdp.send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }, sid);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || "页面 JS 抛错");
  return r.result.value;
}

const userDir = "/tmp/artifacts-diag-profile";
/* ---------------------------------------------------------------- 起浏览器 */
// 每次都清 profile：localStorage 里存着上次跑剩的会话作用域，
// 会把这一轮的左栏先按旧作用域收窄掉，测出来的就不是当前行为了。
try { require("node:fs").rmSync(userDir, { recursive: true, force: true }); } catch { /* 忽略 */ }
const chrome = spawn(findChrome(), [
  "--headless=new", `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${userDir}`,
  "--no-sandbox", "--disable-gpu", "--hide-scrollbars", "--window-size=1440,900",
  "--no-first-run", "--disable-dev-shm-usage", "about:blank",
], { stdio: ["ignore", "ignore", "pipe"] });
let wsUrl = "";
for (let i = 0; i < 60 && !wsUrl; i++) {
  await sleep(250);
  try { wsUrl = (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json()).webSocketDebuggerUrl; }
  catch { /* 还没起来 */ }
}
if (!wsUrl) { console.error("Chromium 起不来"); process.exit(1); }

const cdp = await Cdp.connect(wsUrl);
const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
const { sessionId: sid } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
await cdp.send("Page.enable", {}, sid);
await cdp.send("Runtime.enable", {}, sid);
await cdp.send("Network.enable", {}, sid);
await cdp.send("Emulation.setDeviceMetricsOverride",
  { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }, sid);

const consoleErrs = [];
let ovl = [];
cdp.ws.on("message", (raw) => {
  const m = JSON.parse(raw.toString());
  if (m.method === "Runtime.consoleAPICalled" && m.params?.type === "error") {
    consoleErrs.push((m.params.args || []).map((a) => a.value || a.description).join(" "));
  }
  if (m.method === "Runtime.exceptionThrown") {
    consoleErrs.push(m.params?.exceptionDetails?.exception?.description || "exception");
  }
});

S("0 打开页面");
await cdp.send("Page.navigate", { url: PAGE_URL }, sid);
await sleep(4500);
console.log("标题:", await evalJs(cdp, sid, "document.title"));
/* 先确认真 API 在页面视角里到底返回了什么，别在「前端没画出来」上找原因 */
const truth = await evalJs(cdp, sid, `(async () => {
  const [ws, list] = await Promise.all([
    fetch('/api/artifacts/workspace').then(r => r.json()).catch(e => ({err: String(e)})),
    fetch('/api/artifacts?limit=400').then(r => r.json()).catch(e => ({err: String(e)})),
  ]);
  return {
    wsProjects: (ws.projects || []).map(p => ({
      name: p.name, sessions: (p.sessions || []).length,
      arts: (p.artifacts || []).length,
      perSession: (p.sessions || []).map(s => s.id + '=' + (s.artifacts || []).length),
    })),
    listCount: (list.artifacts || []).length,
    total: list.total,
  };
})()`);
console.log("API 真相:", JSON.stringify(truth, null, 1));
console.log("成果节点数:", await evalJs(cdp, sid, "document.querySelectorAll('.art-node-artifact').length"));
console.log("JS 错误:", consoleErrs.length ? consoleErrs.slice(0, 5) : "无");

/* ------------------------------------------------------------ 页面内小工具 */
await evalJs(cdp, sid, `
  window.__ovl = () => {
    const sel = ['button', '.art-node', '.art-node-name', '.art-node-count', '.art-node-meta',
                 '.art-anno-hint', '.art-anno-head', '.art-toolbar .title', '.art-toolbar .ver',
                 '.art-stage', '.art-main', '.art-side', '.art-anno', '.art-project-head',
                 '.art-node-head', '.art-select', '.art-anno-actions > *'].join(',');
    const els = [...document.querySelectorAll(sel)].filter((e) => {
      const r = e.getBoundingClientRect();
      const cs = getComputedStyle(e);
      return r.width > 1 && r.height > 1 && cs.visibility !== 'hidden' && cs.display !== 'none' && cs.opacity !== '0';
    });
    const out = [];
    for (let i = 0; i < els.length; i++) {
      for (let j = i + 1; j < els.length; j++) {
        const a = els[i], b = els[j];
        if (a.contains(b) || b.contains(a)) continue;   // 父子不算重叠
        const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
        const ox = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left);
        const oy = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top);
        if (ox > 2 && oy > 2) {
          out.push({
            a: (a.tagName + '.' + (a.className || '')).slice(0, 46),
            b: (b.tagName + '.' + (b.className || '')).slice(0, 46),
            at: (a.textContent || '').trim().slice(0, 16),
            bt: (b.textContent || '').trim().slice(0, 16),
            ox: Math.round(ox), oy: Math.round(oy),
          });
        }
      }
    }
    return out;
  };
  window.__desc = (e) => e ? (e.tagName + (e.id ? '#' + e.id : '') + (e.className ? '.' + String(e.className).trim().split(/\\s+/).join('.') : '')) : '(null)';
  true;
`);

/* ---------------------------------------------------------------- 问题 2 */
S("问题2 · 左栏布局（空白态，1440x900）");
const side = await evalJs(cdp, sid, `(() => {
  const inner = document.querySelector('.art-side-inner');
  const cs = getComputedStyle(inner);
  const kids = [...inner.children].map((e, i) => {
    const r = e.getBoundingClientRect();
    return { i, el: (e.tagName + '.' + (e.className || '')).replace(/\\s+/g, '.').slice(0, 40),
             y: Math.round(r.y), h: Math.round(r.height), rows: e.textContent.trim().length };
  });
  const tree = document.getElementById('artTree');
  const tr = tree ? tree.getBoundingClientRect() : null;
  return {
    declaredRows: cs.gridTemplateRows,
    declaredCols: cs.gridTemplateColumns,
    childrenCount: inner.children.length,
    kids,
    tree: tr ? { y: Math.round(tr.y), h: Math.round(tr.h), scrollTop: tree.scrollTop,
                 scrollH: tree.scrollHeight, clientH: tree.clientHeight,
                 nodes: tree.querySelectorAll('.art-node-artifact').length } : null,
    sideCount: document.getElementById('sideCount')?.textContent,
    viewportH: innerHeight,
  };
})()`);
console.log(JSON.stringify(side, null, 1));
if (side.tree && side.tree.scrollH > side.tree.clientH) {
  console.log(`  ★ 树内容 ${side.tree.scrollH}px 放不进 ${side.tree.clientH}px 的盒子（可滚 ${side.tree.scrollH - side.tree.clientH}px）`);
}
if (side.tree && side.tree.y > 200) {
  console.log(`  ★ 树顶在 y=${side.tree.y}，上方 ${side.tree.y - 52}px 是空白 —— 就是截图里那片空地`);
}

ovl = await evalJs(cdp, sid, "__ovl()");
console.log(`重叠对数量: ${ovl.length}`);
ovl.slice(0, 14).forEach((o) =>
  console.log(`  ⚠ ${o.a}「${o.at}」 ×  ${o.b}「${o.bt}」  重叠 ${o.ox}x${o.oy}px`));

/* ---------------------------------------------------------------- 问题 1 */
S("问题1 · 选中会话后还剩多少内容");
const snap = `(() => ({
  arts: document.querySelectorAll('.art-node-artifact').length,
  sessions: document.querySelectorAll('.art-node-session').length,
  projects: document.querySelectorAll('.art-project').length,
  own: [...document.querySelectorAll('.art-node-own')].map(e => e.querySelectorAll('.art-node-artifact').length),
  empty: [...document.querySelectorAll('.art-node-empty')].map(e => e.textContent.trim().slice(0, 30)),
  count: document.getElementById('sideCount')?.textContent,
  selProject: document.getElementById('selProject')?.value || '',
  selSession: document.getElementById('selSession')?.value || '',
  names: [...document.querySelectorAll('.art-node-artifact .art-node-name')].map(e => e.textContent.trim()),
}))()`;

const sessOpts = await evalJs(cdp, sid,
  `[...document.getElementById('selSession').options].map(o => o.value)`);
const projOpts = await evalJs(cdp, sid,
  `[...document.getElementById('selProject').options].map(o => o.value)`);
console.log("项目下拉可选值:", JSON.stringify(projOpts));
console.log("会话下拉可选值:", JSON.stringify(sessOpts));

const setScope = async (proj, sess) => {
  await evalJs(cdp, sid, `(() => {
    const sp = document.getElementById('selProject');
    sp.value = ${JSON.stringify(proj)}; sp.dispatchEvent(new Event('change'));
    const ss = document.getElementById('selSession');
    ${sess === null ? "" : `ss.value = ${JSON.stringify(sess)}; ss.dispatchEvent(new Event('change'));`}
    return true;
  })()`);
  await sleep(900);
};

for (const s of sessOpts) {
  await setScope("", s);
  const r = await evalJs(cdp, sid, snap);
  console.log(`  [${s === "" ? "全部会话(空值)" : s}] 成果 ${r.arts} · 会话节点 ${r.sessions} · 项目 ${r.projects} · 徽标 ${r.count} · 项目直属 ${JSON.stringify(r.own)}`);
  if (r.arts > 0) console.log(`      列出的: ${r.names.slice(0, 10).join(" | ")}`);
  if (r.empty.length) console.log(`      空节点: ${JSON.stringify(r.empty)}`);
}

/* 切到别的项目下，它的会话还能不能选出来 */
await setScope("projB", null);
const crossProj = await evalJs(cdp, sid, `(() => {
  const ss = document.getElementById('selSession');
  return [...ss.options].map(o => o.value + '|' + o.textContent.trim());
})()`);
console.log("切到项目 projB 后，会话下拉列出:", JSON.stringify(crossProj));
const crossCount = await evalJs(cdp, sid, snap);
console.log(`  projB 下成果 ${crossCount.arts} 条 · 会话 ${crossCount.sessions} 个`);

/* ---------------------------------------------------------------- 问题 2b */
S("问题2 · 选中一个成果后的布局重叠");
const picked = await evalJs(cdp, sid, `(() => {
  const n = document.querySelector('.art-node-artifact');
  if (!n) return null; n.click(); return n.dataset.id;
})()`);
await sleep(2500);
console.log("选中成果:", picked);
ovl = await evalJs(cdp, sid, "__ovl()");
console.log(`重叠对数量: ${ovl.length}`);
ovl.slice(0, 18).forEach((o) =>
  console.log(`  ⚠ ${o.a}「${o.at}」 ×  ${o.b}「${o.bt}」  重叠 ${o.ox}x${o.oy}px`));

/* 右栏底部几何：两个键各自多宽、是否挤在一起 */
const foot = await evalJs(cdp, sid, `(() => {
  const g = (s) => { const e = document.querySelector(s); if (!e) return null;
    const r = e.getBoundingClientRect(); const cs = getComputedStyle(e);
    return { w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.x), y: Math.round(r.y),
             display: cs.display, text: (e.textContent||'').trim().slice(0,20) }; };
  return { foot: g('.art-anno-foot'), modes: g('.art-anno-modes'), hint: g('.art-anno-hint'),
           actions: g('.art-anno-actions'), apply: g('#btnApply'), submit: g('#btnSubmit'),
           list: g('#annoList'), panel: g('.art-anno') };
})()`);
console.log("右栏几何:", JSON.stringify(foot, null, 1));

/* ---------------------------------------------------------------- 问题 3 */
S("问题3 · 手势与浏览器原生行为的冲突面");
const gest = await evalJs(cdp, sid, `(() => {
  const pick = (s) => { const e = document.querySelector(s); if (!e) return null;
    const cs = getComputedStyle(e); return { touchAction: cs.touchAction, userSelect: cs.userSelect,
      webkitUserSelect: cs.webkitUserSelect || cs.getPropertyValue('-webkit-user-select'),
      touchCallout: cs.getPropertyValue('-webkit-touch-callout') || '(未设)',
      overscroll: cs.overscrollBehavior, overflow: cs.overflow }; };
  return { stage: pick('#stage'), overlay: pick('#overlay'), draw: pick('.art-draw'),
           body: pick('body'), main: pick('.art-main'),
           htmlTouch: getComputedStyle(document.documentElement).touchAction };
})()`);
console.log(JSON.stringify(gest, null, 1));

const gestureSrc = await evalJs(cdp, sid, `(() => {
  // 页面里的手势代码有没有 preventDefault / touch-action 兜底
  return { hasOverlayAboveFrame: !!document.querySelector('#overlay'),
           armed: document.getElementById('overlay')?.className || '(无 overlay)',
           touchActionSetAnywhere: [...document.styleSheets].some(ss => {
             try { return [...ss.cssRules].some(r => (r.cssText||'').includes('touch-action')); } catch { return false; } }) };
})()`);
console.log("手势兜底:", JSON.stringify(gestureSrc));

/* 实测：stage 上模拟一次「长按后拖动」，看是否被浏览器抢走（选中文字 / 滚动） */
const gestureTest = await evalJs(cdp, sid, `(async () => {
  const stage = document.getElementById('stage');
  stage.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: 400, clientY: 400, pointerId: 1, isPrimary: true, button: 0 }));
  await new Promise(r => setTimeout(r, 60));
  window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: 460, clientY: 460, pointerId: 1, isPrimary: true }));
  window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: 460, clientY: 460, pointerId: 1, isPrimary: true }));
  await new Promise(r => setTimeout(r, 300));
  return { draftCards: document.querySelectorAll('.art-note.draft').length,
           selText: String(window.getSelection()).slice(0, 40) };
})()`);
console.log("拖动后新增草稿:", gestureTest.draftCards, "| 浏览器选区:", JSON.stringify(gestureTest.selText));

/* ---------------------------------------------------------------- 问题 4 */
S("问题4 · 两个按键的状态与语义");
const btnState = await evalJs(cdp, sid, `(() => {
  const q = (s) => { const e = document.querySelector(s); if (!e) return null;
    const r = e.getBoundingClientRect(); const cs = getComputedStyle(e);
    return { text: e.textContent.trim(), disabled: e.disabled, title: e.title || '',
             visible: r.width > 0 && r.height > 0 && cs.display !== 'none' && cs.visibility !== 'hidden',
             w: Math.round(r.width), h: Math.round(r.height),
             pointerEvents: cs.pointerEvents, opacity: cs.opacity,
             coveredBy: (() => {
               const b = r; const el = document.elementFromPoint(b.x + b.width/2, b.y + b.height/2);
               return el && (el === e || e.contains(el)) ? null : (el ? window.__desc(el) : '(无)');
             })() }; };
  return { apply: q('#btnApply'), submit: q('#btnSubmit'),
           foot: q('.art-anno-foot'), anno: q('.art-anno'),
           openNotes: document.querySelectorAll('.art-note').length };
})()`);
console.log(JSON.stringify(btnState, null, 1));

/* 「继续编辑」不该发任何请求；「确认提交」该打出 /apply */
const clickRes = await evalJs(cdp, sid, `(async () => {
  const log = [];
  const orig = window.fetch;
  window.fetch = function (...a) { log.push(String(a[0])); return orig.apply(this, a); };
  const b = document.getElementById('btnApply');
  const wasDisabled = b.disabled;
  b.click();
  await new Promise(r => setTimeout(r, 1200));
  window.fetch = orig;
  return { wasDisabled, fetches: log, afterDisabled: b.disabled, afterText: b.textContent.trim() };
})()`);
console.log("点「继续编辑」:", JSON.stringify(clickRes));
/* 空草稿不该被悄悄交上去；先补一句说明，再点「确认提交」看 /apply 有没有真发出去 */
const emptyDraftClick = await evalJs(cdp, sid, `(async () => {
  const log = [];
  const orig = window.fetch;
  window.fetch = function (...a) { log.push(String(a[0])); return orig.apply(this, a); };
  const b = document.getElementById('btnSubmit');
  const wasDisabled = b.disabled;
  b.click();
  await new Promise(r => setTimeout(r, 1200));
  window.fetch = orig;
  return { wasDisabled, fetches: log, draftsLeft: document.querySelectorAll('.art-note.draft').length };
})()`);
console.log("点「确认提交」(草稿空):", JSON.stringify(emptyDraftClick),
  emptyDraftClick.fetches.some((u) => u.includes("/apply"))
    ? "" : "  ← 没交出去是对的：空说明服务端拒收，停下来问人");

const clickRes2 = await evalJs(cdp, sid, `(async () => {
  const log = [];
  const orig = window.fetch;
  window.fetch = function (...a) { log.push(String(a[0])); return orig.apply(this, a); };
  /* 把草稿说明写上，模拟用户真的写了要改什么 */
  const ta = document.querySelector('[data-ctext]');
  if (ta) {
    ta.value = '标题这一块留白不对';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  }
  const b = document.getElementById('btnSubmit');
  const wasDisabled = b.disabled;
  b.click();
  await new Promise(r => setTimeout(r, 3000));
  window.fetch = orig;
  return { wasDisabled, fetches: log, draftsLeft: document.querySelectorAll('.art-note.draft').length,
           afterText: b.textContent.trim() };
})()`);
console.log("点「确认提交」(补了说明):", JSON.stringify(clickRes2));
console.log(clickRes2.fetches.some((u) => u.includes("/apply"))
  ? "  ✓ 真的发出了 /apply" : "  ★ 没发出 /apply");

/* ------------------------------------- 问题5/6/7：顶栏下拉 / 真切内容 / 折叠边栏 */
S("问题5 · 会话下拉在顶栏、收起左栏也还在");
const scopeBar = await evalJs(cdp, sid, `(() => {
  const bar = document.getElementById('scopeBar');
  const sp = document.getElementById('selProject');
  const ss = document.getElementById('selSession');
  const inTop = (el) => !!el && !!el.closest('.art-topbar');
  const vis = (el) => { if (!el) return false; const b = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return b.width > 0 && b.height > 0 && cs.display !== 'none' && cs.visibility !== 'hidden'; };
  return { barInTopbar: inTop(bar), projectInTopbar: inTop(sp), sessionInTopbar: inTop(ss),
           projectVisible: vis(sp), sessionVisible: vis(ss),
           sessionOptions: ss ? [...ss.options].map(o => o.value) : null,
           barY: bar ? Math.round(bar.getBoundingClientRect().y) : null };
})()`);
console.log(JSON.stringify(scopeBar, null, 1));

S("问题6 · 选会话后中间舞台是不是真的换了");
const switchRes = await evalJs(cdp, sid, `(async () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const ss = document.getElementById('selSession');
  const stageTitle = () => (document.getElementById('stageTitle') || {}).textContent || '';
  const scope = () => window.artifactsApi.state.scope;
  const selOf = () => window.artifactsApi.state.selectedId;
  /* 当前这条成果到底属于哪个会话？直接从树上那份数据里查，不靠猜 */
  const ownerOf = (id) => {
    for (const p of (window.artifactsApi.state.projects || []))
      for (const s of (p.sessions || []))
        if ((s.artifacts || []).some(a => a.id === id)) return s.id;
    return null;
  };
  const sp = document.getElementById('selProject');
  const resetProject = async () => {
    sp.value = ''; sp.dispatchEvent(new Event('change', { bubbles: true }));
    await sleep(700);
  };
  /* 选完一个会话，onchange 会把项目收窄到该会话所属项目，会话下拉也跟着变窄。
     所以每一轮都得先把项目摊回「全部项目」，否则下一个待测会话根本不在下拉里，
     ss.value 赋值会静默变空 —— 那是测试自己写错了，不是页面没换内容。 */
  await resetProject();
  const opts = [...document.getElementById('selSession').options]
    .map(o => o.value).filter(Boolean);
  const out = { steps: [], candidates: opts };
  for (const want of opts.slice(0, 3)) {
    await resetProject();
    const ssel = document.getElementById('selSession');
    if (![...ssel.options].some(o => o.value === want)) {
      out.steps.push({ picked: want, skipped: '切回全部项目后下拉里仍无此会话' });
      continue;
    }
    ssel.value = want;
    ssel.dispatchEvent(new Event('change', { bubbles: true }));
    await sleep(900);
    const sel = selOf();
    out.steps.push({ picked: want, scope: scope().session, selectedId: sel,
                     stageTitle: stageTitle().trim(), owner: ownerOf(sel),
                     ownerMatchesScope: ownerOf(sel) === want });
  }
  return out;
})()`);
console.log(JSON.stringify(switchRes, null, 1));
const allMatch = switchRes.steps.every((s) => s.skipped || s.ownerMatchesScope);
console.log(allMatch ? "  ✓ 每换一次会话，中间成果都属于那个会话"
                     : "  ★ 有会话换过去后中间还是别的会话的东西");

S("问题7 · 左右边栏折叠");
const foldRes = await evalJs(cdp, sid, `(async () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const W = (s) => { const e = document.querySelector(s); return e ? Math.round(e.getBoundingClientRect().width) : null; };
  const snap = () => ({ side: W('.art-side'), anno: W('.art-anno'), main: W('.art-main'),
                        cls: document.getElementById('artBody').className });
  const out = { start: snap(), steps: [] };
  const click = (id) => { document.getElementById(id).click(); };
  click('btnSideToggle'); await sleep(500); out.steps.push({ act: '收起左栏', ...snap() });
  click('btnSideToggle'); await sleep(500); out.steps.push({ act: '展开左栏', ...snap() });
  click('btnAnnoToggle'); await sleep(500); out.steps.push({ act: '收起右栏', ...snap() });
  click('btnAnnoToggle'); await sleep(500); out.steps.push({ act: '展开右栏', ...snap() });
  click('btnSideToggle'); click('btnAnnoToggle'); await sleep(500);
  out.steps.push({ act: '两个都收起', ...snap() });
  /* 都收起时，顶栏下拉和两个折叠键还必须点得到 */
  const sp = document.getElementById('selProject');
  const hit = document.elementFromPoint(sp.getBoundingClientRect().x + 20,
                                       sp.getBoundingClientRect().y + 8);
  out.reachableWhileCollapsed = !!(sp.closest('.art-topbar')) && hit && sp.contains(hit);
  out.selectUsableWhileCollapsed = !sp.disabled && !sp.disabled;
  click('btnSideToggle'); click('btnAnnoToggle'); await sleep(500);
  out.restored = snap();
  return out;
})()`);
console.log(JSON.stringify(foldRes, null, 1));
const near = (v) => v !== null && v <= 1;
const okFold = near(foldRes.steps.find((s) => s.act === "收起左栏").side)
  && near(foldRes.steps.find((s) => s.act === "收起右栏").anno)
  && near(foldRes.steps.find((s) => s.act === "两个都收起").side)
  && near(foldRes.steps.find((s) => s.act === "两个都收起").anno)
  && foldRes.restored.side > 100 && foldRes.restored.anno > 100;
console.log(okFold ? "  ✓ 左右栏能独立收起、也能还原"
                   : "  ★ 折叠/还原没走通");
console.log(foldRes.reachableWhileCollapsed
  ? "  ✓ 两栏都收起时，顶栏下拉依然点得到" : "  ★ 两栏收起后顶栏下拉点不到");

/* ---------------------------------------------------------------- 截图 */
const shot = await cdp.send("Page.captureScreenshot", { format: "png" }, sid);
writeFileSync(path.join(SHOT_DIR, "diag-1440.png"), Buffer.from(shot.data, "base64"));
await cdp.send("Emulation.setDeviceMetricsOverride",
  { width: 390, height: 844, deviceScaleFactor: 2, mobile: true }, sid);
await sleep(1200);
const shot2 = await cdp.send("Page.captureScreenshot", { format: "png" }, sid);
writeFileSync(path.join(SHOT_DIR, "diag-390.png"), Buffer.from(shot2.data, "base64"));
console.log(`\n截图: ${SHOT_DIR}/diag-1440.png  ${SHOT_DIR}/diag-390.png`);

chrome.kill();
process.exit(0);
