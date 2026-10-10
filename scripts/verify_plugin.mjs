/**
 * M1 ⑥⑦ 插件清单验证：用 PilotDeck 本体的解析函数跑一遍 plugin.json，
 * 再拿解析出来的 spec 真连一次侧车，证明「装上就能用」。
 *
 * 验证的是真实代码路径：
 *   parsePluginMcpServers      —— 清单 → PilotDeckMcpServerSpec[]
 *   patchProjectScopedMcpSpec  —— 关键陷阱：http spec 原样放行（stdio 才会被硬编码分支拦）
 *   McpClient                  —— 用解析结果真连、真 listTools、真 callTool
 *
 * 跑法：
 *   node artifacts-mcp.mjs &
 *   PILOTDECK_SRC=/home/Marc/PilotDeck-src node scripts/verify_plugin.mjs [plugin.json 路径]
 */
import { pathToFileURL } from "node:url";
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";

const SRC = process.env.PILOTDECK_SRC || "/home/Marc/PilotDeck-src";
const d = (rel) => pathToFileURL(`${SRC}/dist/${rel}`).href;
const DEFAULT_PLUGIN = `${homedir()}/.pilotdeck/plugins/artifacts/plugin.json`;
const PLUGIN = process.argv[2] || DEFAULT_PLUGIN;

let pass = 0, fail = 0;
const ok = (m, x) => { pass++; console.log(`  [PASS] ${m}${x ? ` — ${x}` : ""}`); };
const no = (m, x) => { fail++; console.log(`  [FAIL] ${m}${x ? ` — ${x}` : ""}`); };
const check = (c, m, x) => (c ? ok(m, x) : no(m, x));
const section = (t) => console.log(`\n[${t}]`);

const { parsePluginMcpServers } = await import(d("src/mcp/runtime/parsePluginMcpServers.js"));
const { patchProjectScopedMcpSpec } = await import(d("src/mcp/runtime/projectMcpSpec.js"));
const { McpClient } = await import(d("src/mcp/client/McpClient.js"));

// ---------------------------------------------------------- [1] 清单就位
section("1 插件清单");
console.log(`      清单路径: ${PLUGIN}`);
check(existsSync(PLUGIN), "plugin.json 存在");
if (!existsSync(PLUGIN)) process.exit(1);
const manifest = JSON.parse(readFileSync(PLUGIN, "utf8"));
check(typeof manifest.name === "string" && manifest.name.length > 0, "name 合法", manifest.name);
check(!!manifest.mcpServers && typeof manifest.mcpServers === "object", "声明了 mcpServers");

/* 回归时 run_all_verify.sh 把侧车起在随机端口，并 export ARTIFACTS_MCP_URL；
   但清单里写死的是安装时的固定端口（默认 8801）。两边对不上，
   McpClient 就会去连一个没人监听的地址，报 "fetch failed" —— 这个失败跟
   插件代码无关，纯粹是测试连错了端口。
   这里把清单里的 url 换成回归端口，再走真实的 parsePluginMcpServers：
   测的仍然是「清单 → PilotDeck 解析 → McpClient 真连」这条完整链路，
   而且不用写坏用户家目录里那份已安装的插件清单。
   没设 ARTIFACTS_MCP_URL 时保持原样，仍按安装时的端口测。 */
const ENV_URL = process.env.ARTIFACTS_MCP_URL;
if (ENV_URL && manifest.mcpServers?.artifacts) {
  console.log(`      清单端口 ${manifest.mcpServers.artifacts.url} → 回归端口 ${ENV_URL}`);
  manifest.mcpServers.artifacts.url = ENV_URL;
}

// ---------------------------------------------------------- [2] 解析不被丢
section("2 PilotDeck 解析");
const parsed = parsePluginMcpServers(manifest.mcpServers);
console.log(`      diagnostics: ${JSON.stringify(parsed.diagnostics)}`);
check(parsed.servers.length === 1, "解析出 1 个 server", String(parsed.servers.length));
check(parsed.diagnostics.length === 0, "无丢弃诊断", JSON.stringify(parsed.diagnostics));
const spec = parsed.servers[0];
check(spec.id === "artifacts", "server id = artifacts", spec.id);
check(spec.transport === "streamable_http", "走 streamable_http（绕开 stdio 硬编码分支）", spec.transport);

// ---------------------------------------------------------- [3] 硬编码分支放行
section("3 patchProjectScopedMcpSpec 放行");
const patched = patchProjectScopedMcpSpec(spec, process.cwd(), homedir());
check(patched.transport === "streamable_http", "传输类型未被改写", patched.transport);
check(patched.url === spec.url, "URL 原样放行", patched.url);

// ---------------------------------------------------------- [4] 真连真调
section("4 用解析结果真连侧车");
const client = new McpClient({ id: patched.id, transport: patched.transport, url: patched.url });
await client.start();
check(client.getStatus() === "ready", "客户端 ready", client.getStatus());

const tools = await client.listTools();
const wires = tools.map((t) => t.wireName);
console.log(`      wire 名: ${JSON.stringify(wires)}`);
check(wires.includes("mcp__artifacts__publish_artifact"), "模型侧能看到 publish_artifact");
check(wires.includes("mcp__artifacts__get_artifact_feedback"), "模型侧能看到 get_artifact_feedback");

const r = await client.callTool("get_artifact_feedback", { artifact_id: "art_nope" });
check(r.isError === true, "工具错误可读（模型知道原因，不是静默失败）",
  (r.content?.[0]?.text || "").slice(0, 80));
await client.stop?.();

console.log("\n" + "=".repeat(56));
console.log(fail === 0
  ? `结果：全部通过 ✓（${pass} 项）— 装上 plugin.json 即可用，无需改 PilotDeck 源码`
  : `结果：${fail} 项失败（共 ${pass + fail} 项）`);
console.log("=".repeat(56));
process.exit(fail === 0 ? 0 : 1);
