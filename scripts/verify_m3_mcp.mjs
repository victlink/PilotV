/**
 * M3 侧车验收：新增的两个工具真的能被调起来，且不是空壳。
 *
 *   node scripts/verify_m3_mcp.mjs
 * 环境：控制台 127.0.0.1:8899（ARTIFACTS_API），侧车 127.0.0.1:8801
 */
const API = process.env.ARTIFACTS_API || "http://127.0.0.1:8899";
const MCP = process.env.ARTIFACTS_MCP_URL || "http://127.0.0.1:8801/api/artifacts-mcp";

let pass = 0;
let fail = 0;
const check = (cond, msg, detail) => {
  cond ? pass++ : fail++;
  console.log(`  [${cond ? "PASS" : "FAIL"}] ${msg}${detail ? ` — ${detail}` : ""}`);
};
const section = (t) => console.log(`\n[${t}]`);

let id = 0;
async function rpc(method, params) {
  const r = await fetch(MCP, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
  });
  const text = await r.text();
  const line = text.split("\n").find((l) => l.startsWith("data:")) || "";
  return JSON.parse(line.slice(5).trim());
}

async function tool(name, args) {
  const res = await rpc("tools/call", { name, arguments: args });
  const body = res.result?.content?.[0]?.text || res.error?.message || "";
  try { return JSON.parse(body); } catch { return { raw: body }; }
}

async function rest(path, init) {
  const r = await fetch(API + path, init);
  return r.json();
}

const html = (t, extra = "") =>
  `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${t}</title></head>
<body><h1>${t}</h1>${extra}</body></html>`;

section("1 准备一条 v1 → v2 的成果链");
const t = Date.now();
const { mkdtemp, writeFile } = await import("node:fs/promises");
const { tmpdir } = await import("node:os");
const { join } = await import("node:path");
const dir = await mkdtemp(join(tmpdir(), "m3mcp-"));
const f1 = join(dir, "v1.html");
const f2 = join(dir, "v2.html");
await writeFile(f1, html(`侧车验证 v1 ${t}`));
await writeFile(f2, html(`侧车验证 v2 ${t}`, "<h2>改过的副标题</h2>"));

const a1 = await rest("/api/artifacts", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ kind: "page", title: `侧车验证 ${t}`, path: f1, agent: "verify-m3-mcp" }),
});
const waitReady = async (aid) => {
  for (let i = 0; i < 60; i++) {
    const a = await rest(`/api/artifacts/${aid}`);
    if (a.status === "ready") return a;
    await new Promise((r) => setTimeout(r, 300));
  }
  return null;
};
check(!!a1.id, "v1 登记成功", a1.id);
await waitReady(a1.id);

await rest(`/api/artifacts/${a1.id}/annotations`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ body: "这块得改", surface: "page", severity: "minor" }),
});
await rest(`/api/artifacts/${a1.id}/dispatch`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ actor: "评审员", note: "改一版" }),
});

const a2 = await rest("/api/artifacts", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ kind: "page", title: `侧车验证 ${t}`, path: f2, parent_id: a1.id, agent: "verify-m3-mcp" }),
});
check(a2.version === 2 && a2.parent_id === a1.id, "v2 挂上 v1", `v${a2.version} parent=${a2.parent_id}`);
await waitReady(a2.id);

section("2 compare_artifact_versions");
const diff = await tool("compare_artifact_versions", { artifact_id: a2.id });
check(diff.source_changed === true, "识别出源码变了", JSON.stringify(diff.source_stats));
check((diff.kept_open || []).length === 1, "看得出还有 1 条没解决", JSON.stringify(diff.kept_open || []));
check(diff.from?.id === a1.id && diff.to?.id === a2.id, "默认跟链上上一版比",
  `${diff.from?.id} → ${diff.to?.id}`);

section("3 wait_artifact_rework");
const t0 = Date.now();
const w1 = await tool("wait_artifact_rework", { artifact_id: a2.id, timeout: 20 });
check(w1.woke === false, "点名的成果没人返工 → 安静超时", `${((Date.now() - t0) / 1000).toFixed(1)}s`);

setTimeout(() => {
  rest(`/api/artifacts/${a2.id}/annotations`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ body: "还是不行", surface: "page", severity: "blocker" }),
  }).then(() => rest(`/api/artifacts/${a2.id}/dispatch`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ actor: "评审员乙", note: "再来" }),
  }));
}, 1500);

const t1 = Date.now();
const w2 = await tool("wait_artifact_rework", { artifact_id: a2.id, timeout: 25 });
const dt = (Date.now() - t1) / 1000;
check(w2.woke === true, "有人返工 → 立刻醒来", `${dt.toFixed(1)}s`);
check(dt < 8, "醒得够快，不用等满超时", `${dt.toFixed(1)}s < 8s`);
const rw = (w2.rework || [])[0] || {};
check(rw.artifact_id === a2.id && (rw.feedback || []).length >= 1, "带回返工清单",
  `${(rw.feedback || []).length} 条`);
check(!!rw.review_url, "带回评审链接", rw.review_url || "");

console.log(`\n结果：${pass} 通过 / ${fail} 失败（共 ${pass + fail} 项）`);
if (fail) process.exit(1);
console.log("全部通过 ✓");
