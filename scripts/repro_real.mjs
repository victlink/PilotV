/* 拿真实数据复现用户报的四类问题（只观察，不改数据）：
 *
 *   node scripts/repro_real.mjs --api http://127.0.0.1:8899
 *
 * 输出：每个类型的实际渲染元素、控制台报错、部件树条目、截图。
 * 不是验收，是「先看清楚」的诊断脚本。
 */
import { spawn } from "node:child_process";
import { existsSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const SRC = process.env.PILOTDECK_SRC || "/home/Marc/PilotDeck-src";
const { default: WebSocket } =
  await import(pathToFileURL(`${SRC}/node_modules/ws/wrapper.mjs`).href);

const argOf = (k, d) => {
  const i = process.argv.indexOf(k);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : d;
};
const API = argOf("--api", "http://127.0.0.1:8899");
const OUT = argOf("--out", "/tmp/repro-shots");

function chromePath() {
  const p = ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium-browser", "/usr/bin/chromium"].filter(existsSync).pop();
  if (!p) throw new Error("找不到 Chromium");
  return p;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const prof = mkdtempSync(join(tmpdir(), "repro-chrome-"));
  const proc = spawn(chromePath(), [
    "--headless=new", "--remote-debugging-port=0", "--no-sandbox",
    "--disable-dev-shm-usage", "--window-size=1600,1000",
    "--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader",
    `--user-data-dir=${prof}`, "about:blank",
  ], { stdio: ["ignore", "pipe", "pipe"] });

  const wsUrl = await new Promise((res, rej) => {
    let buf = "";
    const t = setTimeout(() => rej(new Error("等 Chrome 起来超时")), 20000);
    proc.stderr.on("data", (d) => {
      buf += d.toString();
      const m = buf.match(/ws:\/\/[^\s]+/);
      if (m) { clearTimeout(t); res(m[0]); }
    });
  });

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
  for (const d of ["Page", "Runtime", "Network", "Log"]) await send(`${d}.enable`, {}, sessionId);

  const logs = [];
  sock.on("message", (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.sessionId !== sessionId) return;
    if (m.method === "Runtime.exceptionThrown") {
      logs.push("EXC " + (m.params.exceptionDetails.exception?.description
        || m.params.exceptionDetails.text));
    }
    if (m.method === "Log.entryAdded" && m.params.entry.level === "error") {
      logs.push("ERR " + m.params.entry.text);
    }
    if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") {
      logs.push("CON " + m.params.args.map((a) => a.value ?? a.description ?? "").join(" "));
    }
    if (m.method === "Network.loadingFailed") {
      logs.push("NET " + m.params.errorText + " " + (m.params.type || ""));
    }
  });

  const evalJs = async (expr) => {
    const r = await send("Runtime.evaluate",
      { expression: expr, returnByValue: true, awaitPromise: true }, sessionId);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description
      || r.exceptionDetails.text);
    return r.result.value;
  };
  const shot = async (name) => {
    const r = await send("Page.captureScreenshot", { format: "png" }, sessionId);
    const b = Buffer.from(r.data, "base64");
    writeFileSync(join(OUT, `${name}.png`), b);
    return b.length;
  };

  await send("Emulation.setDeviceMetricsOverride",
    { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false }, sessionId);
  await send("Page.navigate", { url: `${API}/artifacts.html` }, sessionId);
  await evalJs(`new Promise((r)=>{const t0=Date.now();(function w(){
    if(document.querySelector('.art-node-artifact'))return r(1);
    if(Date.now()-t0>25000)return r(0);setTimeout(w,200);})()})`);
  await sleep(1500);

  console.log("\n=== 树里到底列了多少条 ===");
  console.log(await evalJs(`(() => {
    const all = [...document.querySelectorAll('.art-node-artifact')];
    /* 只数真正看得见的：折叠掉的旧版本还在 DOM 里，
       把它们算进去就看不出「左栏到底还堵不堵」。 */
    const vis = all.filter(n => n.offsetParent !== null || n.getClientRects().length);
    const kinds = {};
    for (const n of vis) {
      const k = (n.querySelector('.art-node-icon')||{}).textContent || '?';
      kinds[k] = (kinds[k]||0)+1;
    }
    const dupBadges = [...document.querySelectorAll('.art-ver-more')]
      .map(e => e.textContent.trim()).filter(Boolean);
    return 'DOM 共 ' + all.length + ' 个成果节点，实际可见 ' + vis.length
      + ' 个，按图标 ' + JSON.stringify(kinds)
      + ' ｜ 折叠徽章 ' + dupBadges.length + ' 个，例：' + dupBadges.slice(0,5).join(' ')
      + ' ｜ 侧栏计数 ' + ((document.getElementById('sideCount')||{}).textContent||'?');
  })()`));

  const pick = async (kind, nth = 0) => evalJs(`(() => {
    const all = [...document.querySelectorAll('.art-node-artifact')];
    const hit = all[${nth}];
    if (!hit) return null;
    hit.click();
    return hit.getAttribute('data-id');
  })()`);

  for (const kind of ["drawing", "video", "model3d", "page"]) {
    logs.length = 0;
    const id = await evalJs(`(() => {
      const all = [...document.querySelectorAll('.art-node-artifact')];
      for (const n of all) {
        const ic = (n.querySelector('.art-node-icon')||{}).textContent || '';
        if (ic === '${kind === "drawing" ? "⌗" : kind === "video" ? "▶" : kind === "model3d" ? "◈" : "▣"}') {
          n.click(); return n.getAttribute('data-id');
        }
      }
      return null;
    })()`);
    console.log(`\n======== ${kind}  (${id}) ========`);
    await sleep(3500);
    const info = await evalJs(`(() => {
      const q = (s) => document.querySelector(s);
      const r = q('.art-render');
      const kids = r ? [...r.children].map((c) => {
        const b = c.getBoundingClientRect();
        return { tag: c.tagName.toLowerCase(),
                 w: Math.round(b.width), h: Math.round(b.height),
                 src: (c.getAttribute('src') || '').slice(0, 90) };
      }) : [];
      return {
        parts: [...document.querySelectorAll('.art-part')].map(
          (x) => x.textContent.trim().replace(/\\s+/g, ' ')).slice(0, 12),
        partCount: document.querySelectorAll('.art-part').length,
        render: kids,
        hint: (q('.art-hint') || {}).textContent || '',
        mvErr: window.modelViewerError || null,
        mvDefined: !!window.customElements.get('model-viewer'),
      };
    })()`);
    console.log(JSON.stringify(info, null, 1).slice(0, 1400));
    const bytes = await shot(kind);
    console.log(`截图 ${kind}.png ${bytes}B`);
    if (logs.length) console.log("控制台:\n  " + [...new Set(logs)].slice(0, 8).join("\n  "));
  }

  // 视频：原生控制条能不能点到
  console.log("\n======== 视频控制条可点性 ========");
  const vcase = await evalJs(`(() => {
    const v = document.querySelector('video');
    const ov = document.querySelector('.art-overlay');
    if (!v) return { video: false };
    const vb = v.getBoundingClientRect();
    const ob = ov.getBoundingClientRect();
    const at = document.elementFromPoint(
      vb.left + vb.width / 2, Math.min(vb.bottom - 6, ob.bottom - 4));
    return {
      video: true, controls: v.hasAttribute('controls'),
      overlayArmed: ov.classList.contains('armed'),
      overlayCoversBottom: ob.bottom >= vb.bottom - 1,
      elementAtControlStrip: at ? at.tagName.toLowerCase() + '.' + (at.className||'') : null,
    };
  })()`);
  console.log(JSON.stringify(vcase, null, 1));

  sock.close();
  proc.kill("SIGTERM");
}

main().catch((e) => { console.error("复现脚本挂了:", e.message); process.exit(1); });