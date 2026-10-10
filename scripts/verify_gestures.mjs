/* 需求 2/3/4/5 的真实浏览器验收：用 Chromium(CDP) 开成果台，按真手势操作。
 *
 * 这里只信 DOM 和网络：单击是不是产生了一个编号气泡、按住拖是不是产生了一个
 * 框、点不动的时候有没有弹菜单、部件切换是不是真的换了渲染源、三维是不是
 * 真的画出了像素（不是只把 <model-viewer> 标签挂上去）。
 *
 *   node scripts/verify_gestures.mjs --api http://127.0.0.1:8899
 *
 * 页面本身走 console 鉴权，跟 verify_page.mjs 一样签一个自签 Cookie。
 */
import { spawn, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, createHmac } from "node:crypto";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { assertTestServer, NotATestServer } from "./_test_guard.mjs";

// ws 装在 PilotDeck 源码树里，不在本项目 node_modules —— 与 verify_page.mjs 同源。
const SRC = process.env.PILOTDECK_SRC || "/home/Marc/PilotDeck-src";

const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PASS = [];
const FAIL = [];
const check = (ok, name, detail = "") => {
  (ok ? PASS : FAIL).push(name);
  console.log(`  [${ok ? "PASS" : "FAIL"}] ${name}${detail ? ` — ${detail}` : ""}`);
  return ok;
};

const argOf = (k, d) => {
  const i = process.argv.indexOf(k);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : d;
};
const API = argOf("--api", process.env.ARTIFACTS_API || "http://127.0.0.1:8899");

/* 本脚本会 POST 四个成果（页面/文档/图纸/三维）进库。手动裸跑对着正式
   8799 执行就会灌一屏测试件，所以开跑前先确认数据目录是隔离的。 */
try {
  const dataDir = await assertTestServer(API, process.env.ARTIFACTS_TOKEN, {
    force: process.argv.includes("--force"),
  });
  console.log(`护栏：目标数据目录 ${dataDir}`);
} catch (e) {
  if (e instanceof NotATestServer) {
    console.error(`拒绝执行：${e.message}`);
    process.exit(3);
  }
  throw e;
}

/* ------------------------------------------------------------ fixture */
const GLB = (() => {
  // 一个真能渲染的极简三角面 GLB（3 个顶点 + 1 个面），比占位字节更早暴露
  // 「<model-viewer> 挂着但什么都没画出来」这种假通过。
  const positions = new Float32Array([0, 1, 0, -1, -1, 0, 1, -1, 0]);
  const pos = Buffer.from(positions.buffer);
  const idx = Buffer.from(new Uint16Array([0, 1, 2]).buffer);
  const pad = (n) => Buffer.concat([Buffer.from(positions.buffer ? new Uint8Array(n) : [])]);
  const chunk = (type, data) => {
    const head = Buffer.alloc(8);
    head.writeUInt32LE(data.length, 0);
    head.write(type, 4, "ascii");
    const b = Buffer.alloc(4);
    b.writeUInt32LE(data.length, 0);
    return Buffer.concat([head, Buffer.concat([data, Buffer.alloc((4 - (data.length % 4)) % 4)])]);
  };
  const gltf = {
    asset: { version: "2.0" },
    scenes: [{ nodes: [0] }],
    scene: 0,
    nodes: [{ mesh: 0, name: "tri" }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    accessors: [{
      bufferView: 0, componentType: 5126, count: 3, type: "VEC3",
      min: [-1, -1, 0], max: [1, 1, 0],
    }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: pos.length }],
    buffers: [{ byteLength: pos.length + idx.length }],
  };
  const bin = Buffer.concat([pos, idx]);
  const jsonBuf = Buffer.from(JSON.stringify(gltf), "utf8");
  const jsonPad = Buffer.alloc((4 - (jsonBuf.length % 4)) % 4, 0x20);
  const binPad = Buffer.alloc((4 - (bin.length % 4)) % 4, 0);
  const json = chunk("JSON", Buffer.concat([jsonBuf, jsonPad]));
  const bink = chunk("BIN\0", Buffer.concat([bin, binPad]));
  const total = 12 + 8 + json.length + 8 + bink.length;
  const head = Buffer.alloc(12);
  head.write("glTF", 0, "ascii");
  head.writeUInt32LE(2, 4);
  head.writeUInt32LE(total, 8);
  return Buffer.concat([head, json, bink]);
})();

const post = async (p, body) => {
  const r = await fetch(`${API}${p}`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};

/* ------------------------------------------------------------ CDP */
function findChrome() {
  const cands = [
    process.env.CHROME_PATH,
    "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium-browser", "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
  ].filter(Boolean);
  const found = cands.filter((p) => existsSync(p)).pop();
  if (!found) throw new Error("找不到 Chromium，请设 CHROME_PATH");
  return found;
}

async function consoleCookie(origin) {
  if (process.env.PILOTDECK_CONSOLE_COOKIE) return process.env.PILOTDECK_CONSOLE_COOKIE;
  // serve_test.py 是把成果台直接挂在裸 app 上的，没有 console 的鉴权中间件，
  // 拿不到密钥就不要 cookie —— 回环本来就不拦，别为了凑一个假凭据把验收卡死。
  const envPath = join(ROOT, "console", ".env");
  if (!existsSync(envPath)) return "";
  let secret = "";
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^CONSOLE_SESSION_SECRET\s*=\s*(.+?)\s*$/);
    if (m) { secret = m[1].replace(/^["']|["']$/g, ""); break; }
  }
  if (!secret) return "";
  const b64 = (s) => Buffer.from(s, "utf8").toString("base64url");
  const raw = `${b64("verify.expires." + (Date.now() + 3600_000))}`;
  const mac = createHmac("sha256", secret).update(raw).digest("hex");
  return `pdc_console=${raw}.${mac}`;
}

async function main() {
  /* --- 造料：一个页面、一个文档、一个带部件树的三维模型 --- */
  const src = mkdtempSync(join(tmpdir(), "art-gest-"));
  const proj = join(src, "project");
  mkdirSync(proj, { recursive: true });
  const page = join(proj, "index.html");
  writeFileSync(page, `<!doctype html><meta charset=utf-8><title>成品页</title>
    <style>body{margin:0;font:16px/1.6 system-ui}h1{padding:24px;margin:0;background:#eef}</style>
    <h1>最终网页</h1><p id=p>点我</p>
    <script>document.getElementById('p').onclick=()=>{document.title='已点击'}</script>`);
  /* 需求 5 验的是「落原项目目录 + 注入对应会话」，前提是这份成果真的归属到
     一个项目会话。所以把成果目录直接放进隔离的 PilotDeck 家目录，照
     pilotdeck_workspace 认的布局造 .cwd 和 chats/<sid>.jsonl。 */
  const pdHome = process.env.PILOTDECK_HOME || "";
  const pid = "gest-proj";
  const sid = "cli:gest-sess-1";
  const pstore = join(pdHome, "projects", pid);
  mkdirSync(join(pstore, "chats"), { recursive: true });
  writeFileSync(join(pstore, ".cwd"), proj);
  writeFileSync(join(pstore, "chats", `${sid}.jsonl`),
    JSON.stringify({ type: "user", text: "做一张说明图" }) + "\n");
  check(pdHome.length > 0 && existsSync(join(pstore, ".cwd")),
    "成果被放进一个可归属的 PilotDeck 项目里", `${pid} @ ${pdHome}`);

  const doc = join(proj, "readme.md");
  writeFileSync(doc, "# 说明\n\n第一段原文。\n\n第二段原文。\n");
  const mdir = join(proj, "asm");
  mkdirSync(mdir, { recursive: true });
  writeFileSync(join(mdir, "body.glb"), GLB);
  writeFileSync(join(mdir, "wing.glb"), GLB);
  writeFileSync(join(mdir, "plate.svg"),
    `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="120">` +
    `<rect width="200" height="120" fill="#3b82f6"/><circle cx="60" cy="60" r="28" fill="#fff"/></svg>`);
  writeFileSync(join(mdir, "asm.glb"), GLB);
  /* 图纸：主文件 + 两页部件。PDF 是手搓的最小合法文件（见 scripts/make_mini_pdf.py） */
  const ddir = join(proj, "drawings");
  mkdirSync(ddir, { recursive: true });
  const miniPdf = join(ROOT, "scripts", "make_mini_pdf.py");
  for (const [name, title] of [["plan-a", "PLAN-A"], ["plan-b", "PLAN-B"]]) {
    writeFileSync(join(ddir, `${name}.pdf`),
      execFileSync("python3", [miniPdf, "-", title], { encoding: "buffer" }));
  }
  writeFileSync(join(ddir, "set.pdf"),
    execFileSync("python3", [miniPdf, "-", "PLAN-A"], { encoding: "buffer" }));
  writeFileSync(join(ddir, "set.parts.json"), JSON.stringify({
    version: 1, label: "图纸集", parts: [
      { id: "planA", label: "一层平面图", path: "plan-a.pdf" },
      { id: "planB", label: "二层平面图", path: "plan-b.pdf" },
    ],
  }));

  writeFileSync(join(mdir, "asm.parts.json"), JSON.stringify({
    version: 1, label: "装配体", parts: [
      { id: "body", label: "机身", path: "body.glb" },
      { id: "wing", label: "机翼", path: "wing.glb" },
      { id: "plate", label: "底板图纸", path: "plate.svg" },
    ],
  }));

  const aPage = (await post("/api/artifacts",
    { kind: "page", title: "最终网页", path: page, agent: "verify-gest" })).body;
  const aDoc = (await post("/api/artifacts",
    { kind: "doc", title: "说明文档", path: doc, agent: "verify-gest",
      project: pid, run_id: sid })).body;
  // 部件清单不手工喂：后端看到 <主文件>.parts.json 就会自动发现部件
  const aDrw = (await post("/api/artifacts",
    { kind: "drawing", title: "图纸集", path: join(ddir, "set.pdf"),
      agent: "verify-gest", project: pid, run_id: sid })).body;
  check(!!aDrw.id, "图纸集发布成功", aDrw.id);
  const aM3d = (await post("/api/artifacts",
    { kind: "model3d", title: "装配体", path: join(mdir, "asm.glb"), agent: "verify-gest" })).body;
  check(!!aPage.id && !!aDoc.id && !!aM3d.id, "三份成果都发布成功",
    `${aPage.id} ${aDoc.id} ${aM3d.id}`);

  /* --- 浏览器 --- */
  const profile = mkdtempSync(join(tmpdir(), "art-gest-prof-"));
  const chrome = spawn(findChrome(), [
    "--headless=new", "--remote-debugging-port=0", "--no-sandbox",
    /* model-viewer 要 WebGL：直接 --disable-gpu 会让它在初始化时炸掉
       （reading 'xr'），于是「三维画不出来」和「三维加载失败」变成同一件事。
       交给 SwiftShader 软渲染，验收才真的覆盖到三维这一段。 */
    "--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader",
    "--hide-scrollbars", "--window-size=1440,900",
    `--user-data-dir=${profile}`, "about:blank",
  ], { stdio: ["ignore", "ignore", "pipe"] });

  const wsUrl = await new Promise((resolve, reject) => {
    let buf = "";
    const to = setTimeout(() => reject(new Error("Chromium 没吐 DevTools 地址")), 20000);
    chrome.stderr.on("data", (d) => {
      buf += d.toString();
      const m = buf.match(/ws:\/\/[^\s]+/);
      if (m) { clearTimeout(to); resolve(m[0]); }
    });
  });

  const { default: WebSocket } =
    await import(pathToFileURL(`${SRC}/node_modules/ws/wrapper.mjs`).href);
  const sock = new WebSocket(wsUrl, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
  await new Promise((r) => sock.once("open", r));
  let mid = 0;
  const waiting = new Map();
  sock.on("message", (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); }
  });
  const send = (method, params = {}, sessionId) => new Promise((res, rej) => {
    const id = ++mid;
    waiting.set(id, (m) => (m.error ? rej(new Error(`${method}: ${m.error.message}`)) : res(m.result)));
    sock.send(JSON.stringify({ id, method, params, sessionId }));
  });

  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  await send("Page.enable", {}, sessionId);
  await send("Runtime.enable", {}, sessionId);
  await send("Network.enable", {}, sessionId);
  await send("Log.enable", {}, sessionId);

  const errors = [];
  sock.on("message", (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.sessionId !== sessionId) return;
    if (m.method === "Runtime.exceptionThrown") {
      errors.push(m.params.exceptionDetails.exception?.description
        || m.params.exceptionDetails.text);
    }
    if (m.method === "Log.entryAdded" && m.params.entry.level === "error") {
      errors.push(m.params.entry.text);
    }
  });

  const evalJs = async (expr) => {
    const r = await send("Runtime.evaluate",
      { expression: expr, returnByValue: true, awaitPromise: true }, sessionId);
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    }
    return r.result.value;
  };

  const cookie = await consoleCookie(API);
  if (cookie) {
    await send("Network.setCookie", {
      name: "pdc_console", value: cookie.split("=").slice(1).join("="),
      domain: "127.0.0.1", path: "/",
    }, sessionId);
  }

  await send("Page.navigate", { url: `${API}/artifacts.html` }, sessionId);
  await evalJs(`new Promise((r) => {
    const t0 = Date.now();
    (function wait() {
      if (document.querySelector('.art-node-artifact')) return r(true);
      if (Date.now() - t0 > 20000) return r(false);
      setTimeout(wait, 200);
    })();
  })`);
  await new Promise((r) => setTimeout(r, 1200));

  const clickArtifact = async (id) => {
    await evalJs(`(() => {
      const n = document.querySelector('[data-id=${JSON.stringify(id)}]');
      if (!n) throw new Error('树上找不到 ' + ${JSON.stringify(id)});
      n.click(); return true;
    })()`);
    await new Promise((r) => setTimeout(r, 1400));
  };

  /* =============================== 需求 3：单击 = 编号，按住拖动 = 框选 */
  console.log("\n[需求 3 手势]");
  await clickArtifact(aPage.id);
  const overlay = await evalJs(`(() => {
    const el = document.getElementById('overlay');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  })()`);
  check(!!overlay && overlay.w > 100 && overlay.h > 100, "拿到可标注的舞台区域",
    JSON.stringify(overlay));

  /* 把当前那条草稿写上说明并保存成正式标注（走页面真实按钮，不走后门） */
  const persistDraft = async (text) => {
    const ok = await evalJs(`(() => {
      const ta = document.querySelector('#annoList [data-ctext]');
      if (!ta) return 'no-textarea';
      ta.focus();
      ta.value = ${JSON.stringify(text)};
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      const sv = document.querySelector('#annoList [data-save]');
      if (!sv) return 'no-save';
      sv.click();
      return 'ok';
    })()`);
    await new Promise((r) => setTimeout(r, 1400));
    return ok;
  };

  /* 关菜单：在菜单以外的地方按一下。不用 Escape —— 那是页面级的快捷键，
     会顺手退掉用户刚点的标注，验收就不该用这种「副作用键」。 */
  const closeMenu = async () => {
    await evalJs(`(() => {
      const side = document.querySelector('.art-side') || document.body;
      side.dispatchEvent(new PointerEvent('pointerdown',
        { bubbles: true, clientX: 40, clientY: 300, button: 0 }));
      return true;
    })()`);
    await new Promise((r) => setTimeout(r, 300));
  };

  const mouse = async (type, x, y, extra = {}) =>
    send("Input.dispatchMouseEvent", {
      type, x, y, button: "left", buttons: extra.buttons ?? (type === "mousePressed" ? 1 : 0),
      clickCount: extra.clickCount ?? 1, ...(extra.modifiers ? { modifiers: extra.modifiers } : {}),
    }, sessionId);

  // 单击 —— 必须出一个编号气泡，不许出框
  const cx = Math.round(overlay.x + overlay.w * 0.42);
  const cy = Math.round(overlay.y + overlay.h * 0.36);
  await mouse("mousePressed", cx, cy);
  await new Promise((r) => setTimeout(r, 60));
  await mouse("mouseReleased", cx, cy);
  await new Promise((r) => setTimeout(r, 1000));
  let marks = await evalJs(`({
    pins: document.querySelectorAll('.art-overlay .art-pin').length,
    boxes: document.querySelectorAll('.art-overlay .art-box').length
  })`);
  check(marks.pins === 1 && marks.boxes === 0,
    "单击 → 1 个编号气泡、0 个框", JSON.stringify(marks));
  const pinTxt = await evalJs(`(document.querySelector('.art-overlay .art-pin')||{}).textContent || ''`);
  check(/1/.test(pinTxt), "编号气泡带着序号", pinTxt);

  // 按住拖动 —— 必须出框，不许再添一个编号
  const bx = Math.round(overlay.x + overlay.w * 0.20);
  const by = Math.round(overlay.y + overlay.h * 0.55);
  await mouse("mousePressed", bx, by);
  await new Promise((r) => setTimeout(r, 90));
  await mouse("mouseMoved", bx + 60, by + 40, { buttons: 1 });
  await mouse("mouseMoved", bx + 120, by + 70, { buttons: 1 });
  await new Promise((r) => setTimeout(r, 60));
  await mouse("mouseReleased", bx + 120, by + 70);
  await new Promise((r) => setTimeout(r, 1000));
  marks = await evalJs(`({
    pins: document.querySelectorAll('.art-overlay .art-pin').length,
    boxes: document.querySelectorAll('.art-overlay .art-box').length
  })`);
  check(marks.pins === 1 && marks.boxes === 1,
    "按住拖动 → 追加 1 个框、编号仍是 1 个（没把拖动也记成单击）", JSON.stringify(marks));
  const boxGeom = await evalJs(`(() => {
    const b = document.querySelector('.art-overlay .art-box');
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height) };
  })()`);
  check(boxGeom && boxGeom.w > 80 && boxGeom.h > 40, "框有真实面积，不是零像素",
    JSON.stringify(boxGeom));

  /* 长按已存在的标注 → 菜单 */
  const pinAt = await evalJs(`(() => {
    const p = document.querySelector('.art-overlay .art-pin');
    const r = p.getBoundingClientRect();
    return { x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2) };
  })()`);
  await mouse("mousePressed", pinAt.x, pinAt.y);
  await new Promise((r) => setTimeout(r, 700));      // 超过长按阈值
  await mouse("mouseReleased", pinAt.x, pinAt.y);
  await new Promise((r) => setTimeout(r, 500));
  let menu = await evalJs(`(() => {
    const m = document.querySelector('.art-note-menu');
    if (!m) return null;
    return {
      items: [...m.querySelectorAll('.art-note-menu-item')].map((b) => b.textContent.trim()),
    };
  })()`);
  check(!!menu && menu.items.length >= 2, "长按已编号标注 → 弹出菜单",
    JSON.stringify(menu && menu.items));
  check(!!menu && menu.items.some((t) => /删/.test(t)), "菜单里有删除",
    JSON.stringify(menu && menu.items));
  check(!!menu && menu.items.some((t) => /填|改/.test(t)),
    "未保存的标注菜单里能去填说明", JSON.stringify(menu && menu.items));
  await closeMenu();

  // 存成正式标注后，长按应该给完整菜单（改说明 / 标记解决 / 复制 / 删）
  const saved = await persistDraft("标题字号调大一点");
  check(saved === "ok", "草稿能通过页面按钮存成正式标注", saved);
  const pinned = await evalJs(`document.querySelectorAll('.art-overlay .art-pin:not(.draft)').length`);
  check(pinned >= 1, "存好后画布上留下的是正式标注气泡", `pins=${pinned}`);
  const pin2 = await evalJs(`(() => {
    const p = document.querySelector('.art-overlay .art-pin:not(.draft)');
    if (!p) return null;
    const r = p.getBoundingClientRect();
    return { x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2) };
  })()`);
  if (pin2) {
    await mouse("mousePressed", pin2.x, pin2.y);
    await new Promise((r) => setTimeout(r, 700));
    await mouse("mouseReleased", pin2.x, pin2.y);
    await new Promise((r) => setTimeout(r, 500));
    const m2 = await evalJs(`(() => {
      const m = document.querySelector('.art-note-menu');
      return m ? [...m.querySelectorAll('.art-note-menu-item')].map((b) => b.textContent.trim()) : null;
    })()`);
    check(!!m2 && m2.some((t) => /改|编辑/.test(t)), "正式标注菜单里有「修改说明」", JSON.stringify(m2));
    check(!!m2 && m2.some((t) => /删/.test(t)), "正式标注菜单里有「删除」", JSON.stringify(m2));
    check(!!m2 && m2.length >= 3, "正式标注菜单动作齐全", JSON.stringify(m2));
  }

  // 右键等价于长按（鼠标上没有长按，用户就靠右键）
  const rightClickMenu = async (target) => {
    await send("Input.dispatchMouseEvent",
      { type: "mousePressed", x: target.x, y: target.y, button: "right", buttons: 2, clickCount: 1 }, sessionId);
    await send("Input.dispatchMouseEvent",
      { type: "mouseReleased", x: target.x, y: target.y, button: "right", buttons: 0, clickCount: 1 }, sessionId);
    await new Promise((r) => setTimeout(r, 600));
    return evalJs(`(() => {
      const m = document.querySelector('.art-note-menu');
      return m ? [...m.querySelectorAll('.art-note-menu-item')].map((b) => b.textContent.trim()) : null;
    })()`);
  };
  await closeMenu();
  if (pin2) {
    const rc = await rightClickMenu(pin2);
    check(!!rc && rc.length >= 2, "右键标注也能打开同一个菜单", JSON.stringify(rc));
    await evalJs(`document.body.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})); true`);
    await new Promise((r) => setTimeout(r, 250));
  }

  // 从菜单删一条：删完画布上真的少一个
  const beforeDel = await evalJs(`document.querySelectorAll('.art-overlay .art-pin, .art-overlay .art-box').length`);
  const delTarget = await evalJs(`(() => {
    const p = document.querySelector('.art-overlay .art-box');
    if (!p) return null;
    const r = p.getBoundingClientRect();
    return { x: Math.round(r.x + 3), y: Math.round(r.y + 3) };
  })()`);
  if (delTarget) {
    await rightClickMenu(delTarget);
    await evalJs(`(() => {
      const b = [...document.querySelectorAll('.art-note-menu-item')].find((x) => /删/.test(x.textContent));
      if (!b) throw new Error('菜单里没有删除项');
      b.click(); return true;
    })()`);
    await new Promise((r) => setTimeout(r, 1400));
    const afterDel = await evalJs(`document.querySelectorAll('.art-overlay .art-pin, .art-overlay .art-box').length`);
    check(afterDel === beforeDel - 1, "从菜单删掉标注后标记真的少了一个", `${beforeDel} → ${afterDel}`);
  }

  /* =============================== 需求 2：部件树 + 真渲染 */
  console.log("\n[需求 2 部件树与渲染]");
  await clickArtifact(aM3d.id);
  await new Promise((r) => setTimeout(r, 2500));
  await evalJs(`(() => { const n = document.querySelector('[data-part="body"]'); if (n) n.click(); return !!n; })()`);
  await new Promise((r) => setTimeout(r, 2600));
  const parts = await evalJs(`({
    rail: !!document.querySelector('.art-parts'),
    items: [...document.querySelectorAll('[data-part]')].map((b) => b.textContent.trim()),
    modelViewer: !!document.querySelector('model-viewer'),
    src: (document.querySelector('model-viewer')||{}).getAttribute
         ? document.querySelector('model-viewer').getAttribute('src') : null
  })`);
  check(parts.rail, "三维成果旁边出现了部件树");
  check(parts.items.length === 3, "部件树上有 3 个部件", JSON.stringify(parts.items));
  check(parts.modelViewer, "模型部件渲染的是真的 <model-viewer>，不是占位图",
    String(parts.src));
  check(!!parts.src && /body\.glb/.test(parts.src),
    "换部件后 model-viewer 的 src 真的换了", String(parts.src));

  // 关键：不能只是把标签挂上去 —— 换部件后画面像素必须变
  const frameHash = async () => {
    const shot = await send("Page.captureScreenshot",
      { format: "png", clip: { x: overlay.x + 40, y: overlay.y + 40,
        width: Math.max(60, Math.min(360, overlay.w - 80)),
        height: Math.max(60, Math.min(300, overlay.h - 80)), scale: 1 } }, sessionId);
    const h = createHash("sha1").update(shot.data).digest("hex");
    return { h, bytes: Buffer.from(shot.data, "base64").length };
  };
  await evalJs(`(() => {
    const n = document.querySelector('[data-part="body"]'); if (n) n.click(); return !!n;
  })()`);
  await new Promise((r) => setTimeout(r, 2600));
  const fBody = await frameHash();
  await evalJs(`(() => {
    const n = document.querySelector('[data-part="plate"]'); if (n) n.click(); return !!n;
  })()`);
  await new Promise((r) => setTimeout(r, 2200));
  const fPlate = await frameHash();
  check(fBody.bytes > 1200, "部件渲染区真的画出了东西（截图非空白）", `${fBody.bytes}B`);
  check(fBody.h !== fPlate.h, "切换部件后画面确实换了（两张截图不同）",
    `${fBody.h.slice(0, 10)} vs ${fPlate.h.slice(0, 10)}`);
  const plateIsSvg = await evalJs(`(() => {
    const img = document.querySelector('.art-render img, .art-render embed');
    return img ? (img.tagName + ':' + (img.getAttribute('src')||'').slice(-5)) : null;
  })()`);
  check(!!plateIsSvg && /svg/i.test(plateIsSvg), "SVG 部件走的是矢量渲染", String(plateIsSvg));

  /* 部件上的标注要跟着部件走 */
  await evalJs(`(() => { const sel = document.querySelector('[data-part="plate"]'); if (sel) sel.click(); return !!sel; })()`);
  await new Promise((r) => setTimeout(r, 1800));
  await mouse("mousePressed", Math.round(overlay.x + overlay.w * 0.5),
    Math.round(overlay.y + overlay.h * 0.5));
  await new Promise((r) => setTimeout(r, 60));
  await mouse("mouseReleased", Math.round(overlay.x + overlay.w * 0.5),
    Math.round(overlay.y + overlay.h * 0.5));
  await new Promise((r) => setTimeout(r, 1200));
  const pSave = await persistDraft("底板图纸的圆要再大一点");
  check(pSave === "ok", "部件上的标注能存下来", pSave);
  const partAnchor = await fetch(`${API}/api/artifacts/${aM3d.id}`)
    .then((r) => r.json()).then((j) => (j.annotations || []).map((n) => n.anchor?.part));
  check(partAnchor.includes("plate"), "标在部件上的标注记住了自己属于哪个部件",
    JSON.stringify(partAnchor));

  /* 图纸：PDF 真渲染 + 部件切换 */
  await clickArtifact(aDrw.id);
  await new Promise((r) => setTimeout(r, 1800));
  const drw = await evalJs(`(() => {
    const items = [...document.querySelectorAll('[data-part]')].map((b) => b.textContent.trim());
    document.querySelector('[data-part="planB"]') && document.querySelector('[data-part="planB"]').click();
    return { items };
  })()`);
  check(drw.items.length === 2, "图纸集能列出 2 个部件", JSON.stringify(drw.items));
  await new Promise((r) => setTimeout(r, 2200));
  /* 栅格页 <img> 是主路径（<embed> 放 PDF 在没插件的浏览器上就是黑框），
     <embed> 是 pdftoppm 失败时的兜底，两条都算「真的在显示」。 */
  const pdfShown = await evalJs(`(() => {
    const e = document.querySelector('img[data-pdf-page]')
           || document.querySelector('.art-render embed, .art-render object, .art-render iframe');
    if (!e) return null;
    const r = e.getBoundingClientRect();
    /* 看完整 src：栅格页是 .../part-pages/<name>/<页码>，
       只截最后几个字符等于没验。 */
    return { tag: e.tagName, src: e.getAttribute('src')||'',
             w: Math.round(r.width), h: Math.round(r.height) };
  })()`);
  check(!!pdfShown && /plan-b/.test(String(pdfShown.src)),
    "选中第二张图纸后渲染源真的切了过去", JSON.stringify(pdfShown));
  check(!!pdfShown && pdfShown.w > 120 && pdfShown.h > 80,
    "PDF 预览有实际显示面积（不是 0×0 的空壳）", JSON.stringify(pdfShown));
  const drwShot = await frameHash();
  check(drwShot.bytes > 1200, "图纸区真的画出了像素", `${drwShot.bytes}B`);

  /* 图纸上的标注也要记得自己落在哪个部件 */
  await mouse("mousePressed", Math.round(overlay.x + overlay.w * 0.5),
    Math.round(overlay.y + overlay.h * 0.5));
  await new Promise((r) => setTimeout(r, 60));
  await mouse("mouseReleased", Math.round(overlay.x + overlay.w * 0.5),
    Math.round(overlay.y + overlay.h * 0.5));
  await new Promise((r) => setTimeout(r, 700));
  const drwSave = await persistDraft("这张图的比例尺不对");
  check(drwSave === "ok", "图纸上的标注能存下来", drwSave);
  const drwAnchor = await fetch(`${API}/api/artifacts/${aDrw.id}`)
    .then((r) => r.json()).then((j) => (j.annotations || []).map((n) => n.anchor?.part));
  check(drwAnchor.includes("planB"), "图纸标注记住了所属部件", JSON.stringify(drwAnchor));

  /* =============================== 需求 4：文字就地编辑 */
  console.log("\n[需求 4 就地编辑]");
  await clickArtifact(aDoc.id);
  await new Promise((r) => setTimeout(r, 900));
  const canEdit = await evalJs(`(() => {
    const b = document.getElementById('btnEdit');
    return b ? { shown: !b.hidden, disabled: !!b.disabled } : null;
  })()`);
  check(canEdit && canEdit.shown, "文档类成果有「编辑」入口", JSON.stringify(canEdit));
  await evalJs(`document.getElementById('btnEdit').click()`);
  await new Promise((r) => setTimeout(r, 900));
  const editor = await evalJs(`(() => {
    const ta = document.querySelector('.art-text-area');
    return ta ? { len: ta.value.length, hasSave: !!document.getElementById('btnTextSave') } : null;
  })()`);
  check(!!editor && editor.len > 0, "编辑器里载入的是成果台副本的原文",
    JSON.stringify(editor));
  await evalJs(`(() => {
    const ta = document.querySelector('.art-text-area');
    ta.value = '# 改过的标题\\n\\n第二段被改写了。\\n';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await new Promise((r) => setTimeout(r, 400));
  await evalJs(`(() => { const b = document.getElementById('btnTextSave'); if (!b) throw new Error('没有保存按钮'); b.click(); return true; })()`);
  await new Promise((r) => setTimeout(r, 1500));
  const server = await fetch(`${API}/api/artifacts/${aDoc.id}/text`).then((r) => r.json());
  check((server.text || "").includes("第二段被改写了"), "保存后服务端副本确实是新内容",
    JSON.stringify((server.text || "").slice(0, 40)));
  check(readFileSync(doc, "utf8").includes("第一段原文"), "原项目文件仍然没被动过");
  const afterSave = await evalJs(`(() => {
    const ta = document.querySelector('#textArea');
    const prev = document.querySelector('.art-render-text');
    const body = document.querySelector('.art-render') ? document.querySelector('.art-render').textContent : '';
    return { stillEditing: !!ta, editorGone: !prev, body };
  })()`);
  check(afterSave.editorGone, "保存后退出编辑视图，回到成果预览", JSON.stringify(afterSave).slice(0, 120));
  await new Promise((r) => setTimeout(r, 800));
  const reread = await evalJs(`document.querySelector('.art-render') ? document.querySelector('.art-render').textContent : ''`);
  check(!/第一段原文/.test(reread), "预览里已经是保存后的内容，没有闪回旧版",
    JSON.stringify(String(reread).slice(0, 60)));

  /* =============================== 底部两个键：继续编辑 / 确认提交 */
  console.log("\n[底部两个键：继续编辑 / 确认提交]");
  /* 语义从「两个都能提交的键」改成「继续编辑(不提交) + 确认提交(交给 agent)」，
     判据也得跟着换：没意见时「确认提交」该灰，「继续编辑」该亮 ——
     「继续编辑」是「先不交」这条出路，任何时候都得能走。 */
  const emptyApply = await evalJs(`(() => {
    const keep = document.getElementById('btnApply');
    const send = document.getElementById('btnSubmit');
    return {
      keepShown: keep ? !keep.hidden : false, keepDisabled: keep ? !!keep.disabled : null,
      keepText: keep ? keep.textContent.trim() : null,
      sendShown: send ? !send.hidden : false, sendDisabled: send ? !!send.disabled : null,
      sendText: send ? send.textContent.trim() : null,
    };
  })()`);
  check(emptyApply && emptyApply.keepShown, "有「继续编辑」按钮", JSON.stringify(emptyApply));
  check(emptyApply && emptyApply.sendShown, "有「确认提交」按钮", JSON.stringify(emptyApply));
  check(emptyApply && emptyApply.keepDisabled === false,
    "「继续编辑」任何时候都能点（没意见时它是唯一的出路）", JSON.stringify(emptyApply));
  check(emptyApply && emptyApply.sendDisabled,
    "没有任何意见时「确认提交」是禁用的（不让人空跑一次返工）", JSON.stringify(emptyApply));

  await clickArtifact(aDoc.id);
  await new Promise((r) => setTimeout(r, 1200));
  await mouse("mousePressed", Math.round(overlay.x + overlay.w * 0.55),
    Math.round(overlay.y + overlay.h * 0.45));
  await new Promise((r) => setTimeout(r, 60));
  await mouse("mouseReleased", Math.round(overlay.x + overlay.w * 0.55),
    Math.round(overlay.y + overlay.h * 0.45));
  await new Promise((r) => setTimeout(r, 700));
  const docSave = await persistDraft("第二段请改成更口语的说法");
  check(docSave === "ok", "文档上的标注能存下来", docSave);

  /* 框选文字再标注：先在编辑框里选中一段字，再框一块 —— 说明框应当自动带上原文 */
  await evalJs(`(() => { const b = document.getElementById('btnEdit'); if (b) b.click(); return !!b; })()`);
  await new Promise((r) => setTimeout(r, 900));
  await evalJs(`(() => {
    const ta = document.getElementById('textArea');
    ta.focus();
    ta.setSelectionRange(0, 5);
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    return ta.value.slice(0, 5);
  })()`);
  await mouse("mousePressed", Math.round(overlay.x + overlay.w * 0.5),
    Math.round(overlay.y + overlay.h * 0.55));
  await new Promise((r) => setTimeout(r, 60));
  await mouse("mouseReleased", Math.round(overlay.x + overlay.w * 0.5),
    Math.round(overlay.y + overlay.h * 0.55));
  await new Promise((r) => setTimeout(r, 800));
  const selDraft = await evalJs(`(() => {
    const ta = document.querySelector('#annoList [data-ctext]');
    return ta ? ta.value : null;
  })()`);
  check(typeof selDraft === "string" && selDraft.length > 0,
    "框选过的文字被带进标注说明框（不用手抄）", JSON.stringify(selDraft));
  // 草稿留着会挡住「应用」（有意为之：没写完的意见不该被送走），先取消它
  const cancelBtn = await evalJs(`(() => {
    const b = document.querySelector('#annoList [data-cancel]');
    if (!b) return false;
    b.click(); return true;
  })()`);
  check(cancelBtn === true, "草稿可以取消（没写完的意见不会糊里糊涂被送走）");
  await new Promise((r) => setTimeout(r, 700));
  await evalJs(`(() => { const b = document.getElementById('btnTextRevert'); if (b) b.click(); return !!b; })()`);
  await new Promise((r) => setTimeout(r, 500));
  await evalJs(`(() => { const b = document.getElementById('btnEdit'); if (b) b.click(); return !!b; })()`);
  await new Promise((r) => setTimeout(r, 900));

  const applyable = await evalJs(`(() => {
    const b = document.getElementById('btnSubmit');
    return b ? { shown: !b.hidden, disabled: !!b.disabled, text: b.textContent.trim() } : null;
  })()`);
  check(applyable && !applyable.disabled, "有待处理内容时「确认提交」变可点", JSON.stringify(applyable));
  /* 真正交出去的是「确认提交」，不是「继续编辑」 —— 后者不发任何请求 */
  await evalJs(`document.getElementById('btnSubmit').click()`);
  await new Promise((r) => setTimeout(r, 2500));
  const dialog = await evalJs(`(() => {
    const d = document.getElementById('applyResult');
    if (!d) return null;
    return [...d.querySelectorAll('.art-apply-list li')]
      .map((li) => li.className + '|' + li.textContent.replace(/\\s+/g, ' ').trim());
  })()`);
  check(Array.isArray(dialog) && dialog.length === 3,
    "应用结果逐条列出三条通道", JSON.stringify(dialog));
  check(!!dialog && dialog.every((t) => /ok\\|/.test(t)),
    "三条通道全部成功", JSON.stringify(dialog));
  check(!!dialog && dialog.some((t) => /原项目目录/.test(t) && /ok\\|/.test(t)),
    "返工单真的落到了原项目目录", JSON.stringify(dialog));
  check(!!dialog && dialog.some((t) => /会话/.test(t) && /ok\\|/.test(t)),
    "意见真的交接到了对应会话", JSON.stringify(dialog));
  /* 这条通道是「交接」不是「即时送达」：PilotDeck 运行中的会话不会重读
     pending-inputs，所以文案必须如实说明，否则用户会以为 agent 已经在改。 */
  check(!!dialog && dialog.some((t) => /交接/.test(t)),
    "会话通道如实标注为「交接」而不是「即时送达」", JSON.stringify(dialog));

  // 落到磁盘上的证据：返工单按会话分文件夹，队列条目是 queued
  const orderDir = join(proj, ".pilotdeck", "artifacts-rework", sid);
  const orderIdx = existsSync(orderDir) ? readFileSync(join(orderDir, "index.json"), "utf8") : "";
  check(existsSync(orderDir) && orderIdx.includes(aDoc.id),
    "原项目目录里出现按该会话归类的返工单", orderDir);
  const qPath = join(pdHome, "projects", pid, "pending-inputs", `${sid}.json`);
  const queue = existsSync(qPath) ? JSON.parse(readFileSync(qPath, "utf8")) : { items: [] };
  check((queue.items || []).some((i) => JSON.stringify(i).includes(aDoc.id)),
    "返工意见进了该会话的待处理队列", qPath);
  check((queue.items || []).every((i) => i.status === "queued"),
    "队列条目是 queued（不会被当成已经在跑）",
    JSON.stringify((queue.items || []).map((i) => i.status)));
  /* =============================== 需求 1：版本链默认只露出最终版 */
  console.log("\n[需求 1 版本折叠]");
  let prev = null;
  for (const v of ["v1", "v2", "v3"]) {
    writeFileSync(join(proj, "chain.md"), `# 说明文档 ${v}\n\n版本 ${v} 的正文。\n`);
    const r = await post("/api/artifacts",
      { kind: "doc", title: "迭代稿", path: join(proj, "chain.md"),
        agent: "verify-gest", project: pid, run_id: sid, parent_id: prev });
    check(r.status === 200, `版本链发布 ${v}`, `HTTP ${r.status}`);
    prev = r.body.id;
  }
  await new Promise((r) => setTimeout(r, 1800));
  const folded = await evalJs(`(() => {
    const more = document.querySelector('[data-toggle-vers]');
    const olds = [...document.querySelectorAll('.art-ver-old')];
    return {
      hasToggle: !!more,
      toggleLabel: more ? more.textContent.trim() : null,
      oldBlocks: olds.length,
      oldHidden: olds.length > 0 && olds.every((d) => d.hasAttribute('hidden')),
      visibleChainNodes: [...document.querySelectorAll('.art-node-artifact')]
        .filter((n) => n.textContent.includes('迭代稿'))
        .filter((n) => !n.closest('[hidden]')).length
    };
  })()`);
  check(folded.hasToggle, "版本链上有展开旧版本的入口", JSON.stringify(folded));
  check(folded.oldHidden, "旧版本默认是收起的（默认只显示最终成果）", JSON.stringify(folded));
  check(folded.visibleChainNodes === 1,
    "收起状态下这条成果链只露出 1 个节点", JSON.stringify(folded));
  await evalJs(`(() => { const b = document.querySelector('[data-toggle-vers]'); if (b) b.click(); return !!b; })()`);
  await new Promise((r) => setTimeout(r, 800));
  const opened = await evalJs(`(() => {
    const olds = [...document.querySelectorAll('.art-ver-old')];
    return {
      open: olds.some((d) => !d.hasAttribute('hidden')),
      n: [...document.querySelectorAll('.art-node-artifact')]
           .filter((x) => x.textContent.includes('迭代稿'))
           .filter((x) => !x.closest('[hidden]')).length
    };
  })()`);
  check(opened.open && opened.n === 3, "手动展开后能看到全部 3 个版本", JSON.stringify(opened));
  await evalJs(`(() => { const b = document.querySelector('[data-toggle-vers]'); if (b) b.click(); return !!b; })()`);
  await new Promise((r) => setTimeout(r, 500));


  /* =============================== 需求 1：只显示最终成果 */
  console.log("\n[需求 1 展示折叠]");
  const treeNames = await evalJs(`[...document.querySelectorAll('.art-node-artifact')].map((n) => n.textContent.trim())`);
  check(!treeNames.some((t) => /hero\\.png|thumb|元素/.test(t)),
    "树上没有混进页面元素/缩略图", JSON.stringify(treeNames).slice(0, 200));

  /* ---------------- 收尾：JS 错误 ---------------- */
  check(errors.length === 0, "整轮操作零 JS 错误", errors.slice(0, 3).join(" | "));

  console.log("\n" + "=".repeat(60));
  console.log(`结果：${PASS.length} 通过 / ${FAIL.length} 失败（共 ${PASS.length + FAIL.length} 项）`);
  if (FAIL.length) console.log("失败项：\n  - " + FAIL.join("\n  - "));
  console.log("=".repeat(60));

  try { sock.close(); } catch { /* 关闭失败无所谓 */ }
  chrome.kill("SIGKILL");
  process.exit(FAIL.length ? 1 : 0);
}

main().catch((e) => { console.error("验收脚本自己炸了：", e); process.exit(2); });