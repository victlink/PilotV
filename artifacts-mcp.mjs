#!/usr/bin/env node
/**
 * 成果台 MCP 侧车 —— 极薄的一层，只做「MCP 工具调用 → console REST」翻译。
 *
 * 为什么不把 MCP 协议直接实现进 aiohttp：
 *   侧车 ~200 行，换来的是复用官方 SDK（协议正确性由 SDK 保证）。
 *   存储/鉴权/物化/UI 仍全在 console 里，侧车不碰。
 *
 * 踩过的坑（来自 probe-artifacts-e2e.mjs，别改回去）：
 *   1. registerTool 的 inputSchema 用裸 JSON Schema 会抛
 *      "inputSchema must be a Zod schema" → 走低阶 API：new Server() + setRequestHandler
 *   2. 复用同一个 protocol 实例 → "Already connected to a transport"
 *      → stateless 模式，每请求一个工厂函数新建实例
 *   3. zod 不是顶层依赖 → 低阶 API 完全绕开
 *   4. listTools 返回项字段是 toolName / wireName，不是 name
 *   5. 8799 被 console 占用 → 侧车用 8801
 *
 * 启动：node artifacts-mcp.mjs
 * 环境变量：
 *   ARTIFACTS_API   console REST 根（默认 http://127.0.0.1:8799）
 *   ARTIFACTS_PORT  侧车监听端口（默认 8801）
 *   ARTIFACTS_HOST  侧车监听地址（默认 127.0.0.1，只给本机 PilotDeck 用）
 *   PILOTDECK_SRC   MCP SDK 所在仓库（默认 /home/Marc/PilotDeck-src）
 */
import http from "node:http";
import { pathToFileURL } from "node:url";
import path from "node:path";
import os from "node:os";
import { existsSync } from "node:fs";

// SDK 按绝对路径动态加载：侧车不依赖本目录 node_modules，
// 免得为了一个 .mjs 在成果台工作区里再铺一份依赖树。
//
// PILOTDECK_SRC 不再写死某台机器的路径。原来默认 /home/Marc/PilotDeck-src，
// 换设备时这个默认值必然不存在，报错只是一句 ENOENT，看不出是「路径不对」。
// 现在按「环境变量 → 本机常见安装位置」依次找，全落空就明确告诉用户设哪个变量。
const SDK_CANDIDATES = [
  process.env.PILOTDECK_SRC,
  path.join(os.homedir(), "PilotDeck-src"),
  path.join(os.homedir(), "src", "PilotDeck"),
  "/opt/PilotDeck",
].filter(Boolean);

const SDK_SUFFIX = "node_modules/@modelcontextprotocol/sdk/dist/esm";
const SDK_ROOT = SDK_CANDIDATES.map((r) => path.join(r, SDK_SUFFIX)).find((r) => existsSync(r));

if (!SDK_ROOT) {
  console.error(
    "[artifacts-mcp] 找不到 MCP SDK。试过的位置：\n"
    + SDK_CANDIDATES.map((r) => `  ${path.join(r, SDK_SUFFIX)}`).join("\n")
    + "\n请设置 PILOTDECK_SRC 指向装了 @modelcontextprotocol/sdk 的目录。");
  process.exit(1);
}

const sdk = async (rel) => import(pathToFileURL(`${SDK_ROOT}/${rel}`).href);
const { Server } = await sdk("server/index.js");
const { StreamableHTTPServerTransport } = await sdk("server/streamableHttp.js");
const { ListToolsRequestSchema, CallToolRequestSchema } = await sdk("types.js");

const API = process.env.ARTIFACTS_API || "http://127.0.0.1:8799";
const PORT = Number(process.env.ARTIFACTS_PORT || 8801);
const HOST = process.env.ARTIFACTS_HOST || "127.0.0.1";
const PATHNAME = process.env.ARTIFACTS_MCP_PATH || "/api/artifacts-mcp";

/* ------------------------------------------------------------------ REST */

async function call(method, path, body) {
  const opt = { method, headers: {} };
  if (body !== undefined) {
    opt.headers["Content-Type"] = "application/json";
    opt.body = JSON.stringify(body);
  }
  const r = await fetch(`${API}${path}`, opt);
  const text = await r.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { error: text.slice(0, 300) }; }
  if (!r.ok) throw new Error(data.error || `console API ${r.status}: ${path}`);
  return data;
}

const ok = (obj) => ({ content: [{ type: "text", text: JSON.stringify(obj, null, 2) }] });
const fail = (msg) => ({ content: [{ type: "text", text: String(msg) }], isError: true });

/* ------------------------------------------------------------------ 工具 */

const TOOLS = [
  {
    name: "publish_artifact",
    description:
      "Register a deliverable you just produced in the artifacts console, so a human can review it "
      + "and send back annotations. Call this as soon as an output is ready (page/image/video/drawing/"
      + "model3d/doc). Returns an artifact id and a review_url.",
    inputSchema: {
      type: "object",
      properties: {
        kind: {
          type: "string",
          enum: ["page", "image", "video", "drawing", "model3d", "doc"],
          description: "Deliverable type.",
        },
        title: { type: "string", description: "Short human-readable title." },
        path: { type: "string", description: "Absolute or project-relative path to the produced file." },
        url: { type: "string", description: "Live preview URL for page artifacts (e.g. dev server)." },
        run_id: { type: "string", description: "Owning run/session id, for traceability." },
        parent_id: { type: "string", description: "Previous version's artifact id; annotations inherit." },
        project: { type: "string", description: "Project slug, to group artifacts from several tasks." },
        notes: { type: "string", description: "Free-form note stored in source.notes." },
        agent: { type: "string", description: "Producing agent name (default: pilotdeck)." },
      },
      required: ["kind", "title", "path"],
    },
  },
  {
    name: "get_artifact_feedback",
    description:
      "Fetch review annotations a human left on one of your artifacts (coordinates + text). "
      + "Call this before reworking, then publish the new version with parent_id to inherit them.",
    inputSchema: {
      type: "object",
      properties: {
        artifact_id: { type: "string", description: "Artifact id returned by publish_artifact." },
        status: {
          type: "string",
          enum: ["open", "resolved", "all"],
          description: "Which annotations to return (default: open = still outstanding).",
        },
      },
      required: ["artifact_id"],
    },
  },
  {
    name: "wait_artifact_rework",
    description:
      "Block until a human sends your artifact back for rework, then return the outstanding "
      + "annotations (with anchors) and the review URL. Call this right after delivering something "
      + "the user is likely to review, then keep working — it returns as soon as rework is "
      + "dispatched, or empty after the timeout. This is the loop-closing half of publish_artifact: "
      + "you don't wait for the user to remember to tell you about the feedback.",
    inputSchema: {
      type: "object",
      properties: {
        artifact_id: {
          type: "string",
          description: "Artifact id to watch. Omit to wake on any artifact currently in rework.",
        },
        timeout: {
          type: "number",
          description: "Seconds to wait, 1-120 (default 25). Returns empty on timeout, never errors.",
        },
      },
    },
  },
  {
    name: "compare_artifact_versions",
    description:
      "Diff two versions in an artifact chain: which annotations were resolved, which are still "
      + "open, which were dropped, plus a unified diff of the text source when both versions have "
      + "comparable text files. Use it to confirm a rework actually landed before reporting done.",
    inputSchema: {
      type: "object",
      properties: {
        artifact_id: { type: "string", description: "Newer version's artifact id." },
        from_id: {
          type: "string",
          description: "Older version's artifact id. Defaults to the previous version in the chain.",
        },
      },
      required: ["artifact_id"],
    },
  },
];

const HANDLERS = {
  async publish_artifact(args) {
    const out = await call("POST", "/api/artifacts", args);
    return ok({
      artifact_id: out.id,
      version: out.version,
      kind: out.kind,
      status: out.status,
      review_url: out.review_url || `http://${API.replace(/^https?:\/\//, "")}/artifacts.html#${out.id}`,
      hint: "把它给用户看，并说明可以在成果台上框选标注。",
    });
  },

  async get_artifact_feedback(args) {
    const q = args.status && args.status !== "all" ? `?status=${encodeURIComponent(args.status)}` : "";
    const fb = await call("GET", `/api/artifacts/${encodeURIComponent(args.artifact_id)}/feedback${q}`);
    return ok({
      artifact_id: fb.artifact_id,
      version: fb.version,
      status: fb.status,
      count: fb.count,
      annotations: fb.annotations,
      hint: fb.count
        ? "改完后用 publish_artifact 传 parent_id 发布新版本，标注会自动继承并保持未解决。"
        : "没有待处理意见。",
    });
  },

  async wait_artifact_rework(args) {
    const qs = new URLSearchParams();
    if (args.artifact_id) qs.set("aid", args.artifact_id);
    qs.set("timeout", String(Math.max(1, Math.min(Number(args.timeout) || 25, 120))));
    const out = await call("GET", `/api/artifacts/wait-rework?${qs}`);
    return ok({
      woke: out.woke,
      rework: out.rework || [],
      hint: out.woke
        ? "有人提交了返工：按 feedback 里的意见改，然后 publish_artifact 传 parent_id 发新版本。"
        : "这段时间没人返工，继续干别的或交付下一件。",
    });
  },

  async compare_artifact_versions(args) {
    const id = encodeURIComponent(args.artifact_id);
    const q = args.from_id ? `?from=${encodeURIComponent(args.from_id)}` : "";
    const out = await call("GET", `/api/artifacts/${id}/diff${q}`);
    const d = out.diff || {};
    return ok({
      from: d.from,
      to: d.to,
      status_changed: d.status_changed,
      resolved: d.resolved || [],
      kept_open: d.kept_open || [],
      new_notes: d.new_notes || [],
      dropped_open: d.dropped_open || [],
      source_changed: !!(d.source && d.source.available),
      source_stats: d.source ? { added: d.source.added, removed: d.source.removed } : null,
      hint: (d.kept_open || []).length || (d.dropped_open || []).length
        ? "还有意见没解决，别急着交付。"
        : "这一版的意见都处理完了。",
    });
  },
};

/* ------------------------------------------------------------------ 服务器 */

// stateless 模式：每个 HTTP 请求一个独立 protocol 实例（见文件头坑 2）
function createMcpServer() {
  const mcp = new Server(
    { name: "pilotdeck-artifacts", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    const fn = HANDLERS[name];
    if (!fn) return fail(`unknown tool: ${name}`);
    try {
      return await fn(args || {});
    } catch (err) {
      // 工具错误必须回给模型，别把连接搞崩——否则模型只知道「工具坏了」，
      // 不知道是路径写错还是 console 没起来。
      return fail(`${name} 失败：${err.message || err}`);
    }
  });

  return mcp;
}

const server = http.createServer(async (req, res) => {
  if (!req.url?.startsWith(PATHNAME)) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
    return;
  }
  try {
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => transport.close());
    await createMcpServer().connect(transport);
    await transport.handleRequest(req, res);
  } catch (err) {
    console.error("[artifacts-mcp] server error:", err);
    if (!res.headersSent) res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: String(err.message || err) }));
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[artifacts-mcp] 已启动 http://${HOST}:${PORT}${PATHNAME} → ${API}`);
});

// console 没起来时给出可操作的提示，而不是让调用方猜
call("GET", "/api/artifacts/health").then(
  () => console.log("[artifacts-mcp] console API 可达"),
  (err) => console.warn(`[artifacts-mcp] 警告：console API 不可达（${err.message}），工具调用会失败`),
);

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => { server.close(() => process.exit(0)); });
}
