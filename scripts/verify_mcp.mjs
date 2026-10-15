/**
 * M1 ⑦ 端到端验证：PilotDeck 本体 McpClient → artifacts-mcp 侧车 → console REST → 回环。
 *
 * 客户端不是模拟的，是 PilotDeck 编译产物里的真实 McpClient，
 * 走的是插件声明 streamable_http 时完全相同的代码路径。
 *
 * 跑法：
 *   node artifacts-mcp.mjs &                 # 先起侧车
 *   PILOTDECK_SRC=/home/Marc/PilotDeck-src node scripts/verify_mcp.mjs
 */
import { pathToFileURL } from "node:url";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { assertTestServer, NotATestServer } from "./_test_guard.mjs";

const SRC = process.env.PILOTDECK_SRC || "/home/Marc/PilotDeck-src";
const DIST = `${SRC}/dist/src/mcp/client/McpClient.js`;
const API = process.env.ARTIFACTS_API || "http://127.0.0.1:8799";
const MCP_URL = process.env.ARTIFACTS_MCP_URL || "http://127.0.0.1:8801/api/artifacts-mcp";
const HERE = fileURLToPath(new URL("..", import.meta.url));

/* 本脚本会真调 publish_artifact 往库里登记成果（还会写标注）。
   默认 API 恰好是正式端口 8799，裸跑一次就把测试成果灌进真库 ——
   所以开跑前先确认目标数据目录是隔离的（Node 版护栏，规则同 _test_guard.py）。 */
const FORCE = process.argv.includes("--force");
try {
  const dataDir = await assertTestServer(API, process.env.ARTIFACTS_TOKEN, { force: FORCE });
  console.log(`护栏：目标数据目录 ${dataDir}`);
} catch (e) {
  if (e instanceof NotATestServer) {
    console.error(`拒绝执行：${e.message}`);
    process.exit(3);
  }
  throw e;
}

let pass = 0;
let fail = 0;
const ok = (msg, detail) => { pass++; console.log(`  [PASS] ${msg}${detail ? ` — ${detail}` : ""}`); };
const no = (msg, detail) => { fail++; console.log(`  [FAIL] ${msg}${detail ? ` — ${detail}` : ""}`); };
const check = (cond, msg, detail) => (cond ? ok(msg, detail) : no(msg, detail));
const section = (t) => console.log(`\n[${t}]`);

const { McpClient } = await import(pathToFileURL(DIST).href);

// ---------------------------------------------------------- [1] 连接
section("1 侧车连接（PilotDeck 本体客户端）");
const client = new McpClient({ id: "artifacts", transport: "streamable_http", url: MCP_URL });
await client.start();
check(client.getStatus() === "ready", "客户端状态 ready", client.getStatus());

// ---------------------------------------------------------- [2] 工具面
section("2 工具暴露");
const tools = await client.listTools();
const wires = tools.map((t) => t.wireName);
console.log(`      工具: ${JSON.stringify(wires)}`);
// 工具面：M3 又加了 wait/compare 两个，所以这里断言「该有的都在」而不是「一共就 2 个」——
// 写死数量会在加工具那天变成一句假失败（它其实已经骗过一轮回归）。
const NEEDED = ["publish_artifact", "get_artifact_feedback",
                "wait_artifact_rework", "compare_artifact_versions"];
check(tools.length >= 2, "工具面可用", String(tools.length));
check(NEEDED.every((n) => wires.includes(`mcp__artifacts__${n}`)),
      "4 个工具全在（publish/feedback/wait/compare）",
      NEEDED.filter((n) => !wires.includes(`mcp__artifacts__${n}`)).join(",") || "无缺失");
check(tools.every((t) => (t.description || "").trim().length > 0),
      "每个工具都有说明（agent 才知道啥时候用）");

// ---------------------------------------------------------- [3] 登记成果
section("3 publish_artifact 真登记");
const call = async (name, args) => {
  const r = await client.callTool(name, args);
  const text = r.content?.map((c) => c.text || "").join("") || "";
  try { return { data: JSON.parse(text), isError: !!r.isError }; }
  catch { return { data: { raw: text }, isError: !!r.isError }; }
};

const t0 = Date.now();
const pub = await call("publish_artifact", {
  kind: "page",
  title: "MCP 侧车验证落地页",
  path: `${HERE}/demo/landing.html`,
  url: "http://127.0.0.1:5173/",
  run_id: "run_mcp_verify",
  project: "artifacts-console",
  notes: "由 verify_mcp.mjs 登记",
});
const ms = Date.now() - t0;
check(!pub.isError, "调用成功", pub.isError ? pub.data.raw : `${ms}ms`);
const aid = pub.data.artifact_id;
check(/^art_/.test(aid || ""), "拿到 artifact_id", aid);
check(typeof pub.data.version === "number", "拿到 version", String(pub.data.version));
check((pub.data.review_url || "").includes(aid), "review_url 指向该成果", pub.data.review_url);

// REST 侧确实落库了
const restList = await (await fetch(`${API}/api/artifacts?limit=50`)).json();
const inRest = (restList.artifacts || []).some((a) => a.id === aid);
check(inRest, "REST 列表里能查到（同源真相）");

// ---------------------------------------------------------- [4] 人标一条
section("4 评审侧写入标注（模拟人框选）");
const anno = await (await fetch(`${API}/api/artifacts/${aid}/annotations`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    surface: "page", severity: "major",
    body: "首屏标题和副标题间距太挤，且 CTA 文案是英文",
    anchor: { rect: { x: 0.08, y: 0.18, w: 0.62, h: 0.22 } },
    author: "verify_mcp",
  }),
})).json();
check(!!anno.annotation?.seq, "标注写入成功", `seq=${anno.annotation?.seq}`);

// ---------------------------------------------------------- [5] agent 拉反馈
section("5 get_artifact_feedback 回环");
const fb = await call("get_artifact_feedback", { artifact_id: aid });
check(!fb.isError, "调用成功", fb.isError ? fb.data.raw : "");
check(fb.data.count === 1, "拿到 1 条意见", String(fb.data.count));
check(fb.data.annotations?.[0]?.body?.includes("CTA"), "意见正文一致");
check(!!fb.data.annotations?.[0]?.anchor?.rect, "带坐标（agent 才知道改哪）",
  JSON.stringify(fb.data.annotations?.[0]?.anchor?.rect));

// ---------------------------------------------------------- [6] 错误不炸连接
section("6 失败路径");
const bad = await call("get_artifact_feedback", { artifact_id: "art_nope" });
check(bad.isError === true, "不存在的 id 返回错误而不是崩连接");
const after = await call("get_artifact_feedback", { artifact_id: aid });
check(!after.isError, "错误调用后连接仍可用");

await client.stop?.();

// ---------------------------------------------------------- 汇总
console.log("\n" + "=".repeat(56));
console.log(`结果：${fail === 0 ? "全部通过 ✓" : `${fail} 项失败`}（${pass} 通过 / ${fail} 失败）`);
console.log(`成果页：${API.replace(/127\.0\.0\.1/, "localhost")}/`);
console.log("=".repeat(56));
process.exit(fail === 0 ? 0 : 1);
