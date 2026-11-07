// pilotv MCP 工具面 —— 让 PilotDeck 里的 agent 能自查自检，而不是只会改代码。
//
// 为什么要这一层：doctor / verify / export 已经能在终端一条命令跑完，但仓库里的
// agent 看不到它们。它的「验证」只剩「我改了代码，编译过了」，于是把没验证过的
// 东西交给人。把这三件事包成 MCP 工具，agent 就有了和人手一样的自检入口。
//
// 这一层刻意只做翻译，不重新实现任何判断：所有结论都来自 cli/doctor-command.mjs
// 等同一份代码，终端和 MCP 不会出现两套口径（这正是原来 130 个脚本互相抄坏的病根）。
//
// 三条硬约束，都在下面 createToolHandlers / resolveExportOptions 里落实：
//   1. 只读。doctor 的 --fix-manifest 会写盘，deploy 会 ssh 到别的设备，
//      两者都不进 MCP。自检工具不能反过来改变被自检的东西，否则「体检通过」
//      可能只是它自己把被检查的东西改过了。
//   2. 不收凭据。verify 的用户名/密码只从环境变量读，工具参数里没有这两个字段
//      —— 一旦收参数，凭据就会进模型上下文和会话记录。
//   3. 不信任模型给的路径。export 只接受 outDir 且必须落在 review/exports 下，
//      不接受 out：否则一次工具调用就能往磁盘任意位置写文件。

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const REPO_ROOT_DEFAULT = path.resolve(HERE, '..');

/** 工具清单（裸 JSON Schema）。走低阶 API，不用 zod：见 artifacts-mcp.mjs 坑 1/3。 */
export function buildToolManifest() {
  return [
    {
      name: 'pilotv_doctor',
      description:
        'Read-only health check of the local PilotV deployment: expected ports listening, agent-gateway '
        + '/healthz detail, forced-HTTPS on the front gateway, device manifest source vs built copy, TLS '
        + 'certificate expiry, oversized run logs, and whether the three local upstream patches are still '
        + 'applied. Use this BEFORE debugging a report that "something is down", and again after you '
        + 'restart anything. Deliberately read-only: the CLI-only --fix-manifest write is not exposed here. '
        + 'Reminders (warn) are not failures; only fail means something is broken.',
      inputSchema: {
        type: 'object',
        properties: {
          timeoutMs: {
            type: 'integer', minimum: 500, maximum: 20000,
            description: 'Per-probe timeout. Lower it when probing a remote device over Tailscale.',
          },
        },
        required: [],
      },
    },
    {
      name: 'pilotv_verify_live',
      description:
        'Drive a real Chromium through the running UI: reach the service, log in, switch device, open the '
        + 'artifacts tab, and save screenshots as evidence. This is the check that catches "the code '
        + 'compiles but the page is broken". It distinguishes a service that is not listening from a page '
        + 'that is broken, so read the step details instead of only the ok flag. Requires env '
        + 'PILOTV_VERIFY_USER / PILOTV_VERIFY_PASSWORD on the server process; credentials are NOT tool '
        + 'arguments and will never be accepted as one. Costs a few seconds and leaves screenshots under '
        + 'review/.',
      inputSchema: {
        type: 'object',
        properties: {
          base: {
            type: 'string',
            description: 'Base URL of the UI to drive. Default is the local front gateway. Only loopback or a '
              + 'host listed in the device manifest is accepted; anything else is rejected before a browser starts.',
          },
          cdpPort: {
            type: 'integer', minimum: 1024, maximum: 65535,
            description: 'CDP port for the private Chromium profile. Change it if a previous run left one bound.',
          },
        },
        required: [],
      },
    },
    {
      name: 'pilotv_export_artifacts',
      description:
        'Export the artifacts console into a spreadsheet: detail sheet plus programmatically computed '
        + 'per-agent / per-project / per-status rollups. Every number is reduced from the detail rows by '
        + 'code, so it can be recomputed against the detail sheet - do not hand-copy totals out of it. '
        + 'Use this when a human asks "what did we ship" instead of transcribing the console by hand.',
      inputSchema: {
        type: 'object',
        properties: {
          format: { type: 'string', enum: ['xlsx', 'csv'], description: 'Default xlsx.' },
          outDir: {
            type: 'string',
            description: 'Directory under review/exports to write into. Filenames are generated; you cannot '
              + 'choose an output path, and paths outside review/exports are rejected.',
          },
          base: { type: 'string', description: 'Artifacts console REST root. Default http://127.0.0.1:8799.' },
        },
        required: [],
      },
    },
  ];
}

/**
 * 工具调用结果：文本必须是 JSON，错误必须留在 content 里回给模型。
 * 抛异常会打断 MCP 连接，模型只知道「工具坏了」，不知道是自己参数写错还是服务没起。
 */
export function toToolResult(payload) {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
}

export function toToolError(message) {
  return { content: [{ type: 'text', text: String(message) }], isError: true };
}

const EXPORT_DIR_SEGMENTS = ['review', 'exports'];

/**
 * export 的参数落定：默认值 + 路径限制。
 * 单独抽出来是因为「模型能不能借一次工具调用往任意路径写文件」这件事必须可测。
 */
export function resolveExportOptions(args = {}, { repoRoot } = {}) {
  const root = repoRoot || REPO_ROOT_DEFAULT;
  const format = args.format || 'xlsx';
  if (format !== 'xlsx' && format !== 'csv') {
    throw new Error(`format 只认 xlsx / csv，收到 "${format}"`);
  }
  if (args.out !== undefined) {
    throw new Error('不支持 out 参数：输出文件名由时间戳生成，只能指定 outDir（这是为了防止一次工具调用写到任意路径）');
  }
  const allowedRoot = path.resolve(root, ...EXPORT_DIR_SEGMENTS);
  let outDir = allowedRoot;
  if (args.outDir !== undefined) {
    const wanted = path.resolve(root, String(args.outDir));
    const inside = wanted === allowedRoot
      || wanted.startsWith(allowedRoot + path.sep);
    if (!inside) {
      throw new Error(`outDir 必须在 ${allowedRoot} 里面（收到 "${args.outDir}"）`);
    }
    outDir = wanted;
  }
  return { format, outDir, ...(args.base ? { base: args.base } : {}) };
}

/** verify 的 base 限制：只允许本机或清单里的设备主机，不接受任意主机。 */
export function assertVerifyBase(base, { allowedHosts = [], defaultBase } = {}) {
  if (!base) return defaultBase || '';
  let url;
  try {
    url = new URL(base);
  } catch {
    throw new Error(`base 不是合法 URL："${base}"`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`base 只支持 http/https，收到 "${url.protocol}"`);
  }
  const host = url.hostname.toLowerCase();
  const loopback = host === '127.0.0.1' || host === 'localhost' || host === '[::1]';
  const known = allowedHosts.map((h) => String(h).toLowerCase()).includes(host);
  if (!loopback && !known) {
    throw new Error(`base 的主机 "${host}" 既不是本机，也不在设备清单里，拒绝驱动它`);
  }
  return url.origin;
}

/** doctor 报告 → 给模型看的精简结构（丢掉颜色/终端排版，保留 severity 与 fix）。 */
export function doctorPayload(report) {
  const findings = (report.findings || []).map((entry) => ({
    id: entry.id,
    severity: entry.severity,
    title: entry.title,
    detail: entry.detail,
    ...(entry.fix ? { fix: entry.fix } : {}),
  }));
  const counts = { pass: 0, warn: 0, fail: 0 };
  for (const entry of findings) {
    if (counts[entry.severity] !== undefined) counts[entry.severity] += 1;
  }
  // 「没有 fail」不等于「全绿」：warn 说明有东西快了/没配，模型需要知道该不该管。
  const verdict = counts.fail
    ? '有失败项：按 fix 逐条处理，处理完再跑一次 pilotv_doctor'
    : counts.warn
      ? '没有失败项，但有提醒项（多为临期/未配置），不阻塞使用'
      : '全部通过';
  return {
    ok: report.exitCode === 0,
    counts,
    verdict,
    findings,
  };
}

/** verify 结果 → 精简结构。截图路径必须带上：证据本身比结论文字有用。 */
export function verifyPayload(result) {
  return {
    ok: !!result.ok,
    base: result.base,
    fatal: result.fatal || null,
    steps: (result.steps || []).map((step) => ({
      name: step.name,
      ok: !!step.ok,
      detail: step.detail,
      ...(step.reason ? { reason: step.reason } : {}),
    })),
    screenshots: result.screenshots || [],
    consoleErrors: (result.consoleErrors || []).slice(0, 20),
    failedRequests: (result.failedRequests || []).slice(0, 20),
  };
}

/** export 结果 → 精简结构。totals 原样透出：它是从明细算出来的，可以拿去回答人。 */
export function exportPayload(result) {
  return {
    ok: !!result.ok,
    file: result.file || null,
    format: result.format || null,
    totals: result.totals || null,
    sheets: result.sheets || [],
    complete: result.complete !== false,
    pages: result.pages ?? null,
    ...(result.summary ? { error: result.summary } : {}),
  };
}

/**
 * 设备清单 → 允许驱动的主机名。
 * 清单是唯一事实来源：新加一台设备，verify 自动就能用，不用改代码。
 * 读不到清单不报错：那样只会剩下 loopback + ts.net，本机自检照旧能用。
 */
export function allowedVerifyHosts(devices = []) {
  const hosts = [];
  for (const device of devices) {
    const origin = typeof device?.origin === "string" ? device.origin.trim() : "";
    if (!origin) continue;
    try {
      // URL.hostname 已按 WHATWG 规范转小写，再调一次 toLowerCase 是冗余动作。
      hosts.push(new URL(origin).hostname);
    } catch {
      continue;
    }
  }
  return [...new Set(hosts)];
}

/**
 * 处理器表。依赖由外面传进来，理由有两个：测试要能塞假实现；
 * 以及这个模块必须能在没装 MCP SDK 的机器上被 import（SDK 只在 server 壳里加载）。
 */
export function createToolHandlers(deps = {}) {
  const {
    runDoctor,
    verifyLive,
    exportArtifacts,
    repoRoot,
    allowedVerifyHosts = [],
    defaultVerifyBase,
  } = deps;

  const raw = {
    async pilotv_doctor(args) {
      if (args.fixManifest) return toToolError('pilotv_doctor 只读，不支持 fixManifest。要同步设备清单请在终端跑 pilotv doctor --fix-manifest。');
      const timeoutMs = Number(args.timeoutMs) || undefined;
      const report = await runDoctor({ timeoutMs });
      return toToolResult(doctorPayload(report));
    },

    async pilotv_verify_live(args) {
      for (const secret of ['user', 'username', 'password', 'token']) {
        if (args[secret] !== undefined) {
          return toToolError(`pilotv_verify_live 不接受 ${secret} 参数：凭据只从服务端环境变量读，不能经过模型。`);
        }
      }
      const base = assertVerifyBase(args.base, {
        allowedHosts: allowedVerifyHosts,
        defaultBase: defaultVerifyBase,
      });
      const cdpPort = Number(args.cdpPort) || undefined;
      const result = await verifyLive({ ...(base ? { base } : {}), ...(cdpPort ? { cdpPort } : {}) });
      return toToolResult(verifyPayload(result));
    },

    async pilotv_export_artifacts(args) {
      const options = resolveExportOptions(args, { repoRoot });
      const result = await exportArtifacts(options);
      return result.ok ? toToolResult(exportPayload(result)) : toToolError(result.summary || '导出失败');
    },
  };

  // 工具不允许把异常抛出去：一次参数写错就整条 MCP 连接断掉，
  // 模型只看到「工具坏了」，不知道是自己写错了还是服务没起。
  const guarded = {};
  for (const [name, fn] of Object.entries(raw)) {
    guarded[name] = async (args) => {
      try {
        return await fn(args || {});
      } catch (error) {
        return toToolError(`${name} 失败：${error?.message || error}`);
      }
    };
  }
  return guarded;
}

/** SDK 候选路径。写死某台机器的路径 = 换设备只剩一句 ENOENT，看不出是路径不对。 */
export function sdkCandidatePaths({ env = process.env, homedir = () => '', sep = path.sep } = {}) {
  const configured = env.PILOTDECK_SRC;
  const home = homedir();
  const candidates = [];
  if (configured) candidates.push(path.join(configured, 'node_modules', '@modelcontextprotocol', 'sdk'));
  if (home) {
    candidates.push(path.join(home, 'PilotDeck-src', 'node_modules', '@modelcontextprotocol', 'sdk'));
    candidates.push(path.join(home, 'src', 'PilotDeck', 'node_modules', '@modelcontextprotocol', 'sdk'));
  }
  // /opt 只在 POSIX 上意义。Windows 上把它编进去会得到 "\opt\PilotDeck"，
  // 报错信息里多一行看不懂的路径，反而更难排。
  if (sep === '/') candidates.push(path.join('/opt', 'PilotDeck', 'node_modules', '@modelcontextprotocol', 'sdk'));
  return candidates;
}

export function sdkNotFoundError(candidates) {
  return '找不到 MCP SDK（@modelcontextprotocol/sdk）。已尝试：\n  '
    + candidates.join('\n  ')
    + '\n把 PilotDeck 源码目录设给 PILOTDECK_SRC 即可。';
}