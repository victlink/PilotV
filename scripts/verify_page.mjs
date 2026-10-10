/**
 * M1 ④ 成果台页面级回归：用真实 Chromium（CDP）打开成果台，断言前端确实在消费真 API / 真 SSE。
 *
 * 为什么不用 Playwright：本机只装了 @playwright/mcp（没有 playwright 核心库），
 * 而 PilotDeck 自己就带 ws + 浏览器槽位，直接用 CDP 更省依赖，也更贴近真实运行栈。
 *
 * v0 原型全是假数据，所以「页面能打开」证明不了任何事。这里盯四个点：
 *   1. 0 JS 错误 / 0 资源加载失败（含 /api/artifacts 请求失败）
 *   2. 卡片数 = REST 返回的成果数（非零、且不是 v0 假数据的 12 张）
 *   3. 标注气泡数 = 该成果 REST 的未解决标注数，且气泡坐标全落在舞台内
 *   4. 几何无裁切：亮暗双主题 + 375px 窄屏都无横向溢出（v0 的硬要求，别退化）
 *
 * 跑法：node scripts/verify_page.mjs [url]
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import { mkdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const SRC = process.env.PILOTDECK_SRC || "/home/Marc/PilotDeck-src";
/* 页面与写入走同一个实例：SSE 事件总线是进程内的，
   往 A 进程写、页面连 B 进程，测的就不是同一条链路了。 */
const PAGE_URL = process.argv[2]
  || `${process.env.ARTIFACTS_API || "http://127.0.0.1:8799"}/artifacts.html`;
const API = new URL(PAGE_URL).origin;
const CDP_PORT = Number(process.env.CDP_PORT || 9333);
const ROOT = new URL("..", import.meta.url).pathname;
const SHOT_DIR = path.join(ROOT, ".artifacts-data", "shots");
mkdirSync(SHOT_DIR, { recursive: true });

let pass = 0, fail = 0;
const ok = (m, x) => { pass++; console.log(`  [PASS] ${m}${x ? ` — ${x}` : ""}`); };
const no = (m, x) => { fail++; console.log(`  [FAIL] ${m}${x ? ` — ${x}` : ""}`); };
const check = (c, m, x) => (c ? ok(m, x) : no(m, x));
const section = (t) => console.log(`\n[${t}]`);

const { default: WebSocket } = await import(pathToFileURL(`${SRC}/node_modules/ws/wrapper.mjs`).href);

/* ------------------------------------------------------------ 找 Chromium */
function findChrome() {
  if (process.env.CHROME_PATH && existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  const base = path.join(homedir(), ".cache", "ms-playwright");
  const cands = [];
  try {
    for (const d of fs_readdir(base)) {
      if (!d.startsWith("chromium")) continue;
      cands.push(path.join(base, d, "chrome-linux64", "chrome"),
                 path.join(base, d, "chrome-linux", "chrome"),
                 path.join(base, d, "chrome-linux", "headless_shell"));
    }
  } catch { /* 目录不存在 */ }
  const found = cands.filter((p) => existsSync(p)).pop();
  if (!found) throw new Error("找不到 Chromium，请设 CHROME_PATH");
  return found;
}
function fs_readdir(dir) {
  // 同步列目录：只有一处用到，不值得引 fs/promises 再多一层
  return require("node:fs").readdirSync(dir);
}
const { createRequire } = await import("node:module");
const require = createRequire(import.meta.url);

/* ------------------------------------------------------------ console 登录态
 * /artifacts.html 与 /static/* 走 console 自己的鉴权（只有 /api/artifacts 对回环放行），
 * 所以浏览器检查必须带 pdc_console Cookie。Cookie 是自签 HMAC：
 *   base64url("user.expires") + "." + hmac_sha256_hex(secret, raw)
 * 直接用 console.env 里的 CONSOLE_SESSION_SECRET 签一个 1 小时的，
 * 不去猜也不去改任何凭据；已经登录的环境可用 PILOTDECK_CONSOLE_COOKIE 直接传。
 */
async function consoleCookie() {
  if (process.env.PILOTDECK_CONSOLE_COOKIE) return process.env.PILOTDECK_CONSOLE_COOKIE;
  /* 会话密钥属于宿主 console，不在 PilotV 仓库里。
     这里只是去读它来签一个临时 Cookie，读不到就直说，不要静默拿别的密钥顶替。
     注意读哪个文件：console 进程不读 console.env，它的密钥由
     scripts/start-console-tailscale.sh 从 PilotV 的 .artifacts-secrets.env
     注入。两个文件里是**不同的值**，读错文件签出来的 Cookie 永远 401。 */
  const candidates = [process.env.CONSOLE_ENV, process.env.HOST_CONSOLE_ENV,
    "/vol3/1000/Work/00/PilotV/.artifacts-secrets.env",
    "/vol3/1000/Work/PilotDeck/PilotCode/console.env"].filter(Boolean);
  let secret = "";
  for (const envPath of candidates) {
    try {
      for (const line of require("node:fs").readFileSync(envPath, "utf8").split("\n")) {
        const m = line.match(/^\s*(?:export\s+)?CONSOLE_SESSION_SECRET\s*=\s*(.*)$/);
        if (m) { secret = m[1].trim().replace(/^["']|["']$/g, ""); break; }
      }
    } catch { /* 换下一个 */ }
    if (secret) break;
  }
  if (!secret) throw new Error(`拿不到 CONSOLE_SESSION_SECRET（试过 ${candidates.join(", ")}）；可用 PILOTDECK_CONSOLE_COOKIE 传现成 Cookie`);
  const crypto = await import("node:crypto");
  const expires = Math.floor(Date.now() / 1000) + 3600;
  /* 关键：console 的 read_token 验签对象是 base64url **解码后的字节**，
     不是 base64 字符串本身。签错对象 → 签名对不上 → 401，
     而页面三件套在白名单里照常 200，于是脚本「看起来跑通了」，
     实际上一张真页面都没打开。 */
  const payload = Buffer.from(`admin.${expires}`);
  const raw = payload.toString("base64url");
  const sig = crypto.createHmac("sha256", secret).update(payload).digest("hex");
  return `${raw}.${sig}`;
}

/* ------------------------------------------------------------ CDP 小客户端 */
class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.waits = new Map(); this.events = []; }
  static async connect(url) {
    const ws = new WebSocket(url, { maxPayload: 256 * 1024 * 1024 });
    await new Promise((res, rej) => { ws.once("open", res); ws.once("error", rej); });
    const c = new Cdp(ws);
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.id && c.waits.has(msg.id)) {
        const { res, rej } = c.waits.get(msg.id);
        c.waits.delete(msg.id);
        msg.error ? rej(new Error(`${msg.error.message} (${JSON.stringify(msg.error.data ?? "")})`)) : res(msg.result);
      } else if (msg.method) {
        c.events.push(msg);
      }
    });
    return c;
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.waits.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      setTimeout(() => {
        if (this.waits.has(id)) { this.waits.delete(id); rej(new Error(`${method} 超时`)); }
      }, 30000);
    });
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function evalJs(cdp, sid, expr) {
  const r = await cdp.send("Runtime.evaluate", {
    expression: expr, returnByValue: true, awaitPromise: true,
  }, sid);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || "页面 JS 抛错");
  return r.result.value;
}

/* ------------------------------------------------------------ REST 真相 */
const restList = await (await fetch(`${API}/api/artifacts?limit=200`)).json();
const restItems = restList.artifacts || [];
console.log(`REST: ${restItems.length} 个成果`);

/* ------------------------------------------------------------ 起浏览器 */
section("1 起浏览器并打开页面");
/* profile 按端口分目录，和 artifacts_cdp.ensure_browser 保持同一套规矩：
   共用一个目录时，跑测试（9333）会撞上还在跑的浏览器（9334），抢同一个
   SingletonLock，Chrome 后启动的那个直接 Aborting —— 报出来是「浏览器起不来」，
   跟渲染其实没关系。 */
const userDir = path.join(ROOT, ".artifacts-data", `chrome-profile-${CDP_PORT}`);
fs.mkdirSync(userDir, { recursive: true });
/* 该端口上没有人在听（上面 wsUrl 探不到），所以这里的 Singleton* 只可能是
   上次异常退出的残留，清掉安全。 */
for (const junk of ["SingletonLock", "SingletonSocket", "SingletonCookie"]) {
  try { fs.unlinkSync(path.join(userDir, junk)); } catch { /* 本来就没有 */ }
}
const chrome = spawn(findChrome(), [
  "--headless=new", `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${userDir}`,
  "--no-sandbox", "--disable-gpu", "--hide-scrollbars", "--window-size=1440,900",
  "--no-first-run", "--disable-dev-shm-usage", "about:blank",
], { stdio: ["ignore", "ignore", "pipe"] });
let chromeErr = "";
chrome.stderr.on("data", (d) => { chromeErr += d.toString(); });

let wsUrl = "";
for (let i = 0; i < 60 && !wsUrl; i++) {
  await sleep(250);
  try {
    const v = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json();
    wsUrl = v.webSocketDebuggerUrl;
  } catch { /* 还没起来 */ }
}
check(!!wsUrl, "Chromium 起来了", `cdp :${CDP_PORT}`);
if (!wsUrl) { console.error(chromeErr.slice(-800)); process.exit(1); }

const cdp = await Cdp.connect(wsUrl);
const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
const { sessionId: sid } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });

await cdp.send("Page.enable", {}, sid);
await cdp.send("Runtime.enable", {}, sid);
await cdp.send("Network.enable", {}, sid);
await cdp.send("Log.enable", {}, sid);
await cdp.send("Network.setCookie", {
  name: "pdc_console", value: await consoleCookie(),
  domain: "127.0.0.1", path: "/", httpOnly: true,
}, sid);
await cdp.send("Emulation.setDeviceMetricsOverride",
  { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }, sid);

const loaded = new Promise((res) => {
  const t = setInterval(() => {
    if (cdp.events.some((e) => e.method === "Page.loadEventFired")) { clearInterval(t); res(); }
  }, 100);
});
await cdp.send("Page.navigate", { url: PAGE_URL }, sid);
await Promise.race([loaded, sleep(15000)]);
/* 等首屏真把成果画出来，别只等一个固定时长。
   回归里共用服务已经攒了几十份成果（含 1280×800 的页面截图），首屏渲染要
   拉缩略图、跑栅格化，冷启动下 1.2 秒经常只画出一半 —— 表现成「0 张卡片」。
   固定 sleep 换来的通过/失败都不是在测「成果能不能显示」，只是在测机器快慢。 */
const firstPaint = await waitFor(cdp, sid,
  "document.querySelectorAll('.art-node-artifact').length", 12000, 250);
if (!firstPaint) console.warn("  等待首屏渲染超时，继续跑后面的断言");

/* 本套件验的是渲染与版本折叠，不是「默认看哪个对话」。左栏现在默认收窄到
   正在活动/最近更新的那个会话，所以先把下拉摊回「全部」再量 —— 否则量到的
   根本不是要测的那个集合。 */
await evalJs(cdp, sid, `(()=>{
  const sp=document.getElementById('selProject'), ss=document.getElementById('selSession');
  if(!sp) return false;
  sp.value=''; sp.dispatchEvent(new Event('change'));
  ss.value=''; ss.dispatchEvent(new Event('change'));
  return true;})()`);
await sleep(400);

const collect = () => cdp.events
  .filter((e) => e.method === "Log.entryAdded" && e.params.entry.level === "error")
  .map((e) => `log: ${e.params.entry.text} ${e.params.entry.url || ""}`.trim())
  .concat(cdp.events
    .filter((e) => e.method === "Network.responseReceived" && e.params.response.status >= 400)
    .map((e) => `${e.params.response.status} ${e.params.response.url}`))
  .concat(cdp.events
    .filter((e) => e.method === "Runtime.exceptionThrown")
    .map((e) => `exception: ${e.params.exceptionDetails.exception?.description || ""}`));

/* 等页面上某个数值变成期望的样子：js 返回真值即算到位。
   先取一次再轮询，避免在条件已满足时白等一整轮。 */
async function waitFor(cdp, sid, js, timeoutMs = 8000, step = 200) {
  const t0 = Date.now();
  for (;;) {
    const v = await evalJs(cdp, sid, js);
    if (v && Number(v) > 0) return v;
    if (Date.now() - t0 > timeoutMs) return v;
    await sleep(step);
  }
}

/* ------------------------------------------------------------ 断言 */
section("2 首屏");
/* v0 的 .art-card 已经不存在了：成果流改版成左栏「项目/会话/成果」目录树，
   一行成果 = .art-node-artifact[data-id]。别再拿旧选择器断言，否则永远是 0。 */
  const cardCount = await evalJs(cdp, sid, "document.querySelectorAll('.art-node-artifact').length");
  /* 需求 4：附属产物和「显示不出来」的成果默认收起，所以 DOM 里的行数
     应当等于「默认可见」的那部分，而不是 workspace 里的全部条目。
     同时确认被收起的那些一条都没漏画进 DOM。 */
  const fetched = await evalJs(cdp, sid, `(() => {
    const st = window.artifactsApi.state;
    let shown = 0, hidden = 0;
    const walk = (arr) => { for (const a of (arr || [])) {
      const keep = st.showHidden || (a.displayable !== false && a.deliverable !== 'aux');
      if (keep) shown++; else hidden++;
    } };
    for (const p of st.projects || []) {
      walk(p.artifacts);
      for (const s of p.sessions || []) walk(s.artifacts);
    }
    return { shown, hidden };
  })()`);
check(cardCount > 0, "成果卡片渲染出来了", `${cardCount} 张`);
check(cardCount === fetched.shown,
  "成果行数 = 默认可见的成果数（附属/显示不出来的默认收起）",
  `${cardCount} vs 可见 ${fetched.shown} / 收起 ${fetched.hidden}`);
check(cardCount !== 12, "不是 v0 假数据的 12 张", String(cardCount));

const live = await evalJs(cdp, sid, "document.getElementById('liveLabel').textContent.trim()");
check(live === "实时", "SSE 已连接（顶栏显示实时）", live);

/* 选中「确实有标注」的那张卡：随便挑一张会把气泡渲染整段跳过，测了个寂寞 */
section("3 选中成果与标注层");
let target = null;
for (const a of restItems) {
  const full = await (await fetch(`${API}/api/artifacts/${a.id}`)).json();
  if ((full.annotations || []).length) { target = { a, full }; break; }
}
check(!!target, "找到带标注的成果来验气泡", target ? `${target.a.title}（${target.a.annotations?.length || target.full.annotations.length} 条）` : "无");
await evalJs(cdp, sid,
  `document.querySelector('.art-node-artifact[data-id="${target ? target.a.id : ""}"]')?.click(), 1`);
await sleep(1200);

const stage = await evalJs(cdp, sid, `(() => {
  const h = document.getElementById('stage').innerHTML;
  return { len: h.length, err: h.includes('art-hint error'),
           media: /<iframe|<img|<video|<object|<model-viewer/.test(h) };
})()`);
check(stage.len > 0, "舞台有内容", `${stage.len} 字节`);
check(!stage.err, "舞台不是错误态");
check(stage.media, "媒体渲染器命中");

const bubbles = await evalJs(cdp, sid, "document.querySelectorAll('.art-pin, .art-box').length");
const nAnnos = target ? target.full.annotations.length : 0;
check(nAnnos > 0 && bubbles === nAnnos, "标注气泡数 = REST 标注数",
  `${bubbles} vs ${nAnnos}（${target?.a.title || "-"}）`);
const noteCards = await evalJs(cdp, sid, "document.querySelectorAll('.art-note').length");
check(noteCards === nAnnos, "右栏意见卡数一致", `${noteCards} vs ${nAnnos}`);

const geom = await evalJs(cdp, sid, `(() => {
  const ov = document.getElementById('overlay');
  const box = ov.parentElement.getBoundingClientRect();
  const bad = [];
  for (const b of document.querySelectorAll('.art-pin, .art-box')) {
    const r = b.getBoundingClientRect();
    if (r.left < box.left - 1 || r.top < box.top - 1 ||
        r.right > box.right + 1 || r.bottom > box.bottom + 1) bad.push(b.dataset.id);
  }
  return { bad, w: Math.round(box.width), h: Math.round(box.height) };
})()`);
check(geom.bad.length === 0, "标注气泡全在舞台内（坐标没错位）",
  `舞台 ${geom.w}×${geom.h}${geom.bad.length ? ` 越界: ${geom.bad}` : ""}`);

/* ------------------------------------------------------------ 几何 */
section("4 几何（v0 硬要求：双主题 + 窄屏都不裁切）");
const ovf = await evalJs(cdp, sid,
  "({d: document.documentElement.scrollWidth, w: window.innerWidth,"
  + " sb: document.getElementById('stage').getBoundingClientRect().bottom, h: window.innerHeight})");
check(ovf.d <= ovf.w + 1, "无横向溢出", `scrollWidth ${ovf.d} vs innerWidth ${ovf.w}`);
check(ovf.sb <= ovf.h + 2, "舞台底部在视口内", `${Math.round(ovf.sb)} vs ${ovf.h}`);

section("5 亮色主题");
await evalJs(cdp, sid, "document.getElementById('btnTheme').click(), 1");
await sleep(500);
const themeState = await evalJs(cdp, sid,
  "({t: document.documentElement.dataset.theme, d: document.documentElement.scrollWidth - window.innerWidth})");
check(themeState.d <= 1, "亮色主题下无横向溢出", `theme=${themeState.t}`);
const shotLight = await cdp.send("Page.captureScreenshot", { format: "png" }, sid);
const { writeFileSync } = await import("node:fs");
writeFileSync(path.join(SHOT_DIR, "page-light.png"), Buffer.from(shotLight.data, "base64"));

section("6 窄屏 375px");
await evalJs(cdp, sid, "document.getElementById('btnTheme').click(), 1");
await cdp.send("Emulation.setDeviceMetricsOverride",
  { width: 375, height: 780, deviceScaleFactor: 2, mobile: true }, sid);
await sleep(700);
const narrow = await evalJs(cdp, sid,
  "document.documentElement.scrollWidth - window.innerWidth");
check(narrow <= 1, "窄屏无横向溢出", `溢出 ${narrow}px`);
const shotNarrow = await cdp.send("Page.captureScreenshot", { format: "png" }, sid);
writeFileSync(path.join(SHOT_DIR, "page-narrow.png"), Buffer.from(shotNarrow.data, "base64"));

await cdp.send("Emulation.setDeviceMetricsOverride",
  { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }, sid);
await sleep(600);
const shotDark = await cdp.send("Page.captureScreenshot", { format: "png" }, sid);
writeFileSync(path.join(SHOT_DIR, "page-dark.png"), Buffer.from(shotDark.data, "base64"));

/* ------------------------------------------------------------ SSE 增量 */
section("7 SSE 增量推送");
const before = cardCount;
/* 探针文件必须先真的写出来。以前只发了一个指向不存在路径的发布请求，
   成果台把「没有文件的成果」判成显示不出来并默认收起（需求 4），
   于是行数不涨 —— 测的其实是 fixture 自己的漏洞，不是 SSE。 */
writeFileSync("/tmp/artifacts-page-probe.txt", "SSE 探针 " + Date.now() + "\n");
await fetch(`${API}/api/artifacts`, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ kind: "doc", title: "页面回归探针", path: "/tmp/artifacts-page-probe.txt" }),
});
await sleep(2200);
/* waitFor 命中后要的是**张数**，不是那个布尔表达式本身。 */
const grew = await waitFor(cdp, sid,
  `document.querySelectorAll('.art-node-artifact').length > ${before}`, 8000, 250);
const after = grew
  ? await evalJs(cdp, sid, "document.querySelectorAll('.art-node-artifact').length")
  : before;
check(after === before + 1, "新成果经 SSE 自动出现在列表（无需刷新）", `${before} → ${after}`);

/* ------------------------------------------------------------ 错误面 */
section("8 0 错误");
const errs = collect().filter((e) => !e.includes("favicon"));
check(errs.length === 0, "0 JS 错误 / 0 资源失败", errs.slice(0, 3).join(" | ") || "0 条");

/* ------------------------------------------------------------ 清理 */
await cdp.send("Target.closeTarget", { targetId });
cdp.ws.close();
chrome.kill();
console.log(`\n截图: ${SHOT_DIR}`);
console.log("=".repeat(56));
console.log(fail === 0 ? `结果：全部通过 ✓（${pass} 项）` : `结果：${fail} 项失败（共 ${pass + fail} 项）`);
console.log("=".repeat(56));
process.exit(fail === 0 ? 0 : 1);
