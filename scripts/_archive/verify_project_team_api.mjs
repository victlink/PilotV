/**
 * 线上验收脚本：对真实运行的 PilotDeck UI 服务检查 /api/project-team 合约。
 *
 * 用法：
 *   node scripts/_archive/verify_project_team_api.mjs [baseUrl]
 *
 * 环境变量：
 *   PILOTDECK_AUTH_DB   取 jwt_secret 的库（默认 /home/Marc/.pilotdeck/auth.db）
 *   PROJECT_ROOT        要验收的项目根（默认自动从 /api/projects 里挑第一个）
 *   APPLY_WRITES       设成 1 才真正写配置（默认只读；写之前会自动备份并还原）
 *
 * 说明：
 *   - 令牌用本地 auth.db 的 jwt_secret 现签，不接触用户口令。
 *   - 写测试结束后会把原配置原样还原，避免污染真实项目。
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire('/vol3/1000/Work/00/PilotV/pilotdeck-mobile/upstream-official/ui/package.json');
const BASE_URL = process.argv[2] || 'http://127.0.0.1:3001';
const AUTH_DB = process.env.PILOTDECK_AUTH_DB || '/home/Marc/.pilotdeck/auth.db';
const APPLY_WRITES = process.env.APPLY_WRITES === '1';

const results = [];
function log(step, ok, detail) {
  results.push({ step, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} :: ${step}${detail ? ' :: ' + detail : ''}`);
}

function mintToken() {
  const Database = require('better-sqlite3');
  const db = new Database(AUTH_DB, { readonly: true });
  const row = db.prepare('select value from app_config where key = ?').get('jwt_secret');
  db.close();
  if (!row?.value) throw new Error('auth.db 里没有 jwt_secret');
  const jwt = require('jsonwebtoken');
  return jwt.sign({ userId: 1, username: 'Marc' }, row.value, { expiresIn: '2h' });
}

const token = mintToken();
const auth = { Authorization: `Bearer ${token}` };

async function get(url, headers = auth, { truncate = true } = {}) {
  const res = await fetch(url, { headers });
  let raw = '';
  try { raw = await res.text(); } catch { raw = '<unreadable>'; }
  return { status: res.status, body: truncate ? raw.slice(0, 400) : raw, raw };
}

async function put(url, payload, headers = auth) {
  const res = await fetch(url, {
    method: 'PUT',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  let raw = '';
  try { raw = await res.text(); } catch { raw = '<unreadable>'; }
  return { status: res.status, body: raw.slice(0, 400), raw };
}

// ---------------------------------------------------------------- 1. 鉴权
const noAuth = await get(`${BASE_URL}/api/project-team?projectRoot=/tmp`, {});
log('unauthenticated GET rejected', noAuth.status === 401, `status=${noAuth.status} body=${noAuth.body}`);

const badAuth = await get(`${BASE_URL}/api/project-team?projectRoot=/tmp`, { Authorization: 'Bearer not-a-real-token' });
log('invalid token rejected', badAuth.status === 401 || badAuth.status === 403, `status=${badAuth.status}`);

// -------------------------------------------------------- 2. 参数与路径校验
const missingRoot = await get(`${BASE_URL}/api/project-team`);
log('missing projectRoot rejected', missingRoot.status === 400, `status=${missingRoot.status} body=${missingRoot.body}`);

const relativeRoot = await get(`${BASE_URL}/api/project-team?projectRoot=relative/path`);
log('relative projectRoot rejected', relativeRoot.status >= 400, `status=${relativeRoot.status} body=${relativeRoot.body}`);

const unregistered = await get(`${BASE_URL}/api/project-team?projectRoot=/tmp`);
log('unregistered projectRoot rejected', unregistered.status === 404, `status=${unregistered.status} body=${unregistered.body}`);

// ---------------------------------------------------------- 3. 找真实项目
const projectsRes = await get(`${BASE_URL}/api/projects`, auth, { truncate: false });
let projectRoot = process.env.PROJECT_ROOT || '';
if (!projectRoot) {
  let list = [];
  try {
    const parsed = JSON.parse(projectsRes.raw);
    list = Array.isArray(parsed) ? parsed : (parsed.projects || []);
  } catch { list = []; }
  const candidate = list.find((p) => p.fullPath || p.path);
  if (candidate) projectRoot = candidate.fullPath || candidate.path;
}
if (!projectRoot) {
  log('found a registered project root', false, `projects status=${projectsRes.status} body=${projectsRes.body}`);
} else {
  log('found a registered project root', true, projectRoot);

  const current = await get(`${BASE_URL}/api/project-team?projectRoot=${encodeURIComponent(projectRoot)}`);
  log('GET registered project returns config', current.status === 200, `status=${current.status} body=${current.body}`);

  let config = null;
  try { config = JSON.parse(current.raw); } catch { config = null; }
  log(
    'config shape matches {version, revision, collaboration, agents}',
    !!config
      && config.version === 1
      && typeof config.revision === 'string'
      && Array.isArray(config.agents)
      && !!config.collaboration
      && typeof config.collaboration.mode === 'string',
    config ? JSON.stringify({ version: config.version, revision: String(config.revision).slice(0, 12), agents: config.agents.length, mode: config.collaboration.mode }) : current.body,
  );

  const agentShapeOk = (config?.agents ?? []).every((a) =>
    typeof a.id === 'string'
    && typeof a.name === 'string'
    && typeof a.role === 'string'
    && (a.model === null || (a.model && typeof a.model.provider === 'string' && typeof a.model.model === 'string'))
    && !!a.permissions
    && typeof a.permissions.toolAccess === 'string'
    && Array.isArray(a.permissions.allowedTools)
    && Array.isArray(a.permissions.deniedTools));
  log('agent entries match the documented shape', Array.isArray(config?.agents) && agentShapeOk,
    JSON.stringify((config?.agents ?? []).map((a) => ({ id: a.id, role: a.role, model: a.model, toolAccess: a.permissions?.toolAccess }))));

  // 子目录不能冒充项目根
  const sub = await get(`${BASE_URL}/api/project-team?projectRoot=${encodeURIComponent(path.join(projectRoot, 'sub-dir-not-registered'))}`);
  log('subdirectory rejected as project root', sub.status === 404, `status=${sub.status} body=${sub.body}`);

  // 非法负载：未知字段
  const badPayload = await put(`${BASE_URL}/api/project-team?projectRoot=${encodeURIComponent(projectRoot)}`, {
    version: 1,
    revision: config?.revision ?? '',
    agents: [],
    somethingElse: true,
  });
  log('unknown field rejected', badPayload.status === 400, `status=${badPayload.status} body=${badPayload.body}`);

  if (APPLY_WRITES && config) {
    const configPath = path.join(projectRoot, '.pilotdeck', 'project-team.json');
    const backupPath = path.join('/vol3/1000/Work/00/PilotV/.pilotdeck/work', `project-team-backup-${Date.now()}.json`);
    fs.mkdirSync(path.dirname(backupPath), { recursive: true });
    if (fs.existsSync(configPath)) fs.copyFileSync(configPath, backupPath);
    else fs.writeFileSync(backupPath, '');

    const agent = {
      id: 'verify-agent-1',
      name: '验收用 Agent',
      description: '线上验收临时写入',
      role: 'reviewer',
      roleDefinition: '线上验收临时角色',
      model: null,
      enabled: true,
      permissions: {
        toolAccess: 'all',
        allowedTools: ['read_file'],
        deniedTools: [],
        network: 'ask',
        writeScope: 'read-only',
        requireApproval: true,
      },
      reportsTo: null,
    };
    const wrote = await put(`${BASE_URL}/api/project-team?projectRoot=${encodeURIComponent(projectRoot)}`, {
      version: 1,
      revision: config.revision,
      agents: [agent],
      collaboration: { mode: 'manual' },
    });
    log('PUT valid config accepted', wrote.status === 200, `status=${wrote.status} body=${wrote.body}`);

    let wroteConfig = null;
    try { wroteConfig = JSON.parse(wrote.raw); } catch { wroteConfig = null; }
    log('PUT returns a new revision', !!wroteConfig && wroteConfig.revision !== config.revision,
      wroteConfig ? `${String(config.revision).slice(0, 12)} -> ${String(wroteConfig.revision).slice(0, 12)}` : wrote.body);

    const stale = await put(`${BASE_URL}/api/project-team?projectRoot=${encodeURIComponent(projectRoot)}`, {
      version: 1,
      revision: config.revision,
      agents: [agent],
      collaboration: { mode: 'manual' },
    });
    log('stale revision rejected', stale.status === 409, `status=${stale.status} body=${stale.body}`);

    const reread = await get(`${BASE_URL}/api/project-team?projectRoot=${encodeURIComponent(projectRoot)}`);
    let rereadConfig = null;
    try { rereadConfig = JSON.parse(reread.raw); } catch { rereadConfig = null; }
    log('GET reflects the written agent', !!rereadConfig && rereadConfig.agents.some((a) => a.id === 'verify-agent-1'),
      reread.body);

    // 还原
    try {
      if (fs.readFileSync(backupPath, 'utf8').trim()) fs.copyFileSync(backupPath, configPath);
      else if (fs.existsSync(configPath)) fs.unlinkSync(configPath);
      const restored = await get(`${BASE_URL}/api/project-team?projectRoot=${encodeURIComponent(projectRoot)}`);
      log('original config restored', restored.status === 200, `status=${restored.status}`);
    } catch (err) {
      log('original config restored', false, `restore failed: ${err.message}`);
    }
  } else {
    console.log('SKIP :: write-path checks (set APPLY_WRITES=1 to enable)');
  }
}

const failed = results.filter((r) => !r.ok);
console.log(`\nSUMMARY: ${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
