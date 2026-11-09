#!/usr/bin/env node
/**
 * pilotv MCP 侧车 —— 把 doctor / verify / export 暴露给 PilotV 里的 agent。
 *
 * 与 artifacts-mcp.mjs 是同一个套路：极薄的一层，只做「MCP 工具调用 → 本地 CLI」
 * 翻译，所有判断仍住在 cli/ 里。两个侧车不合并：成果台的工具走 REST、生命体征的
 * 工具走本地探测，两者的失败模式完全不同，合在一起只会让一个挂了带走另一个。
 *
 * 端口 8802：8799 是成果台，8801 是成果台 MCP 侧车（见 artifacts-mcp.mjs 坑 5）。
 *
 * 协议壳刻意保持薄到不值得测：参数校验、路径限制、凭据拒绝、结果裁剪全部在
 * cli/mcp-tools.mjs 里，那里有 23 条测试和 19 个变异体。这里只做 SDK 装载、
 * 传输和依赖注入 —— 和 artifacts-mcp.mjs 一样走低阶 API（裸 JSON Schema +
 * setRequestHandler），不依赖 zod。
 *
 * 启动：node cli/mcp-server.mjs
 * 环境变量：
 *   PILOTDECK_SRC    PilotDeck 源码目录（MCP SDK 从它的 node_modules 里取）
 *   PILOTV_MCP_PORT  监听端口（默认 8802）
 *   PILOTV_MCP_HOST  监听地址（默认 127.0.0.1，只给本机用）
 *   PILOTV_MCP_PATH  路径（默认 /api/pilotv-mcp）
 */
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  allowedVerifyHosts,
  buildToolManifest,
  createToolHandlers,
  sdkCandidatePaths,
  sdkNotFoundError,
  toToolError,
} from './mcp-tools.mjs';
import { REPO_ROOT } from './doctor-command.mjs';
import { readDeviceManifest } from '../service/deviceManifest.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PILOTV_MCP_PORT || 8802);
const HOST = process.env.PILOTV_MCP_HOST || '127.0.0.1';
const PATHNAME = process.env.PILOTV_MCP_PATH || '/api/pilotv-mcp';
const DEVICE_MANIFEST = path.join(
  REPO_ROOT, 'pilotdeck-mobile', 'upstream-official', 'ui', 'public', 'devices.json',
);

/**
 * MCP SDK 按绝对路径动态加载：这个仓库不铺第二份 node_modules。
 * 找不到时要说清找过哪里 —— 只回一句 ENOENT，换设备的人会先去查网络。
 */
async function loadSdk() {
  const candidates = sdkCandidatePaths({ env: process.env, homedir: os.homedir });
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    try {
      const server = await import(`${pathToFilePrefix(candidate)}/server/index.js`);
      const schemas = await import(`${pathToFilePrefix(candidate)}/types.js`);
      const httpTransport = await import(
        `${pathToFilePrefix(candidate)}/server/streamableHttp.js`
      );
      if (!server.Server || !schemas.ListToolsRequestSchema || !httpTransport.StreamableHTTPServerTransport) {
        continue;
      }
      return {
        Server: server.Server,
        ListToolsRequestSchema: schemas.ListToolsRequestSchema,
        CallToolRequestSchema: schemas.CallToolRequestSchema,
        StreamableHTTPServerTransport: httpTransport.StreamableHTTPServerTransport,
        from: candidate,
      };
    } catch {
      // 这个候选装了但装坏了：接着试下一个，最后统一报「找过哪些地方」。
    }
  }
  throw new Error(sdkNotFoundError(candidates));
}

// Windows 下 import() 需要 file:// 前缀，而且路径里的反斜杠要归一。
function pathToFilePrefix(dir) {
  const normalized = dir.split(path.sep).join('/');
  const withSlash = normalized.startsWith('/') ? normalized : `/${normalized}`;
  return `file://${encodeURI(withSlash).replace(/#/g, '%23').replace(/\?/g, '%3F')}`;
}

/** verify 能驱动哪些主机 = 设备清单里那几台。清单改了不用重启侧车也能生效，但先不过度设计。 */
function resolveAllowedHosts() {
  const parsed = readDeviceManifest(DEVICE_MANIFEST);
  return allowedVerifyHosts(parsed.devices);
}

async function main() {
  const sdk = await loadSdk();
  const handlers = createToolHandlers({
    runDoctor: (options) => import('./doctor-command.mjs').then((m) => m.runDoctor(options)),
    verifyLive: (options) => import('./verify-live.mjs').then((m) => m.verifyLive(options)),
    exportArtifacts: (options) => import('./export-artifacts.mjs').then((m) => m.exportArtifacts(options)),
    repoRoot: REPO_ROOT,
    allowedVerifyHosts: allowed,
    defaultVerifyBase: process.env.PILOTV_BASE || 'https://127.0.0.1:5186',
  });
  const tools = buildToolManifest();
  const allowed = resolveAllowedHosts();

  // stateless：每个请求一个 protocol 实例（复用 artifacts-mcp 的结论，
  // 复用同一个实例会撞上 "Already connected to a transport"）。
  function createMcpServer() {
    const mcp = new sdk.Server(
      { name: 'pilotv-ops', version: '1.0.0' },
      { capabilities: { tools: {} } },
    );
    mcp.setRequestHandler(sdk.ListToolsRequestSchema, async () => ({ tools }));
    mcp.setRequestHandler(sdk.CallToolRequestSchema, async (req) => {
      const { name, arguments: args } = req.params;
      const fn = handlers[name];
      if (!fn) return toToolError(`unknown tool: ${name}`);
      return fn(args || {});
    });
    return mcp;
  }

  const server = http.createServer(async (req, res) => {
    if (!req.url?.startsWith(PATHNAME)) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
      return;
    }
    try {
      const transport = new sdk.StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on('close', () => transport.close());
      await createMcpServer().connect(transport);
      await transport.handleRequest(req, res);
    } catch (error) {
      console.error('[pilotv-mcp] server error:', error);
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: String(error.message || error) }));
    }
  });

  server.listen(PORT, HOST, () => {
    console.log(`[pilotv-mcp] 已启动 http://${HOST}:${PORT}${PATHNAME}`);
    console.log(`[pilotv-mcp] MCP SDK: ${sdk.from}`);
    console.log(`[pilotv-mcp] 可驱动主机: ${allowed.join(', ') || '(仅本机)'}`);
    console.log(`[pilotv-mcp] 工具: ${tools.map((tool) => tool.name).join(', ')}`);
  });

  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => { server.close(() => process.exit(0)); });
  }
}

// 只有被当成命令跑才执行；被 import 时不产生任何副作用（端口/日志）。
const isMain = process.argv[1]
  && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isMain) {
  main().catch((error) => {
    console.error(`[pilotv-mcp] 启动失败: ${error.message || error}`);
    process.exitCode = 1;
  });
}