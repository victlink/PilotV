import express from 'express';
import fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { resolvePilotHome } from '../utils/pilotPaths.js';
import { clearPendingPermission, listPendingPermissions } from '../pending-permissions.js';

const CHANNELS = new Set(['feishu', 'wecom']);
const session = { id: 'approval-center', title: '审批会话' };

/**
 * The payload of a pending request is never echoed back verbatim. The
 * authoritative redactor (`redactPayload` in `src/approval/ApprovalPolicy.ts`)
 * lives in the compiled native module and `ui/server/` deliberately runs
 * without that build output (see `utils/pilotPaths.js`), so the redactor
 * cannot be reused here. Instead of a weaker local copy of the rules, the
 * concrete values are hidden and only the structure is reported: a field name
 * never carries the secret itself, a value might.
 */
function safeShape(value, depth = 0) {
  if (value === null || value === undefined) return { present: false };
  if (Array.isArray(value)) {
    if (depth >= 2) return { present: true, type: 'array', length: value.length };
    return { present: true, type: 'array', length: value.length, items: value.slice(0, 10).map(item => safeShape(item, depth + 1)) };
  }
  if (typeof value !== 'object') return { present: true, type: typeof value };
  if (depth >= 2) return { present: true, type: 'object' };
  return { present: true, type: 'object', fields: Object.keys(value).slice(0, 40) };
}
function projectOf(entry, resolved) {
  const metadata = resolved && typeof resolved === 'object' ? resolved
    : entry.sessionMetadata && typeof entry.sessionMetadata === 'object' ? entry.sessionMetadata : {};
  const name = metadata.projectName || metadata.project || metadata.name;
  const key = metadata.projectKey || metadata.projectPath;
  return { projectName: typeof name === 'string' && name.trim() ? name.trim() : '未关联项目', projectKey: typeof key === 'string' && key.trim() ? key.trim() : undefined };
}
function safeTimestamp(value) {
  const date = new Date(value ?? 0);
  return Number.isNaN(date.getTime()) ? new Date(0).toISOString() : date.toISOString();
}
async function mapRequest(entry, resolveProject) {
  const project = projectOf(entry, await resolveProject?.(entry));
  return { id: entry.requestId, requestId: entry.requestId, sessionId: entry.sessionId, ...project,
    kind: entry.isElicitation ? 'elicitation' : 'permission', toolName: entry.toolName || 'unknown',
    summary: entry.summary || (entry.isElicitation ? '业务确认' : `工具授权：${entry.toolName || 'unknown'}`),
    input: safeShape(entry.input), context: safeShape(entry.context), createdAt: safeTimestamp(entry.createdAt),
    updatedAt: safeTimestamp(entry.updatedAt), state: 'pending',
    // An unknown risk is displayed as `high`: the UI must never suggest a
    // lower risk than the authoritative policy would compute.
    risk: entry.risk || 'high', expiresAt: safeTimestamp(Number.isFinite(entry.expiresAt) ? entry.expiresAt : Date.parse(safeTimestamp(entry.createdAt)) + 45 * 60 * 1000) };
}
function validateBinding(body) {
  if (!body || typeof body.enabled !== 'boolean') return 'enabled must be boolean';
  if (body.enabled && !CHANNELS.has(String(body.channelKey || '').trim())) return 'channelKey must be feishu or wecom; weixin is unsupported';
  if (body.enabled && (typeof body.chatId !== 'string' || !body.chatId.trim())) return 'chatId must be non-empty when enabled';
  if (!Array.isArray(body.approverIds) || body.approverIds.some(v => typeof v !== 'string' || !v.trim())) return 'approverIds must be non-empty strings[]';
  // An enabled binding without approvers lets anybody in the bound chat
  // answer: the native `checkImBinding` only enforces the list when it is not
  // empty. Enabling therefore requires at least one approver id.
  if (body.enabled && body.approverIds.length === 0) return 'approverIds must list at least one approver when the binding is enabled';
  return null;
}
function bindingPath() { return path.join(resolvePilotHome(), 'approval-bindings.json'); }
function readBindings() {
  const parsed = JSON.parse(fs.readFileSync(bindingPath(), 'utf8'));
  if (!parsed || !Array.isArray(parsed.bindings)) throw new Error('invalid bindings document');
  return parsed.bindings;
}
async function writeBinding(binding) {
  const file = bindingPath(); await fsp.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const existing = fs.existsSync(file) ? readBindings() : [];
  const bindings = existing.filter(b => b?.approvalSession !== 'approval-center' && b?.approvalSource !== 'approval-center');
  if (binding.enabled) bindings.push({ channelKey: binding.channelKey.trim(), chatId: binding.chatId.trim(), approverIds: binding.approverIds.map(v => v.trim()), approvalSession: 'approval-center', approvalSource: 'approval-center' });
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await fsp.writeFile(temp, JSON.stringify({ bindings }, null, 2), { mode: 0o600 });
  await fsp.rename(temp, file);
  return { enabled: binding.enabled, channelKey: binding.enabled ? binding.channelKey.trim() : '', chatId: binding.enabled ? binding.chatId.trim() : '', approverIds: binding.enabled ? binding.approverIds.map(v => v.trim()) : [] };
}

export function createApprovalSessionRouter(deps = {}) {
  const router = express.Router();
  const list = deps.listPending || listPendingPermissions;
  let binding = deps.getBinding?.() || { enabled: false, channelKey: '', chatId: '', approverIds: [] };
  const hasInjectedBinding = typeof deps.getBinding === 'function' || typeof deps.saveBinding === 'function';
  const inFlight = new Set();
  router.get('/', async (_req, res) => {
    try {
      if (hasInjectedBinding) throw new Error('binding supplied by caller');
      const bindings = readBindings();
      const found = bindings.find(b => b?.approvalSession === 'approval-center' || b?.approvalSource === 'approval-center');
      // Fail closed: a stored binding without approvers would let anybody in
      // the bound chat answer, so it is reported as disabled until it is
      // written again with at least one approver id.
      const approverIds = found && Array.isArray(found.approverIds) ? found.approverIds.filter(v => typeof v === 'string' && v.trim()).map(v => v.trim()) : [];
      binding = found && approverIds.length > 0
        ? { enabled: true, channelKey: found.channelKey || '', chatId: found.chatId || '', approverIds }
        : { enabled: false, channelKey: '', chatId: '', approverIds: [] };
    } catch { /* preserve injected/test state when file is absent */ }
    const requests = await Promise.all(list().map(entry => mapRequest(entry, deps.resolveProject)));
    return res.json({ session: { ...session, channelBinding: binding }, requests });
  });
  router.put('/channel', async (req, res) => { const error = validateBinding(req.body); if (error) return res.status(400).json({ error }); try { binding = await (deps.saveBinding ? deps.saveBinding(req.body) : writeBinding(req.body)); return res.json({ session: { ...session, channelBinding: binding } }); } catch (e) { return res.status(500).json({ error: '审批绑定保存失败' }); } });
  router.post('/requests/:id/decision', async (req, res) => {
    const body = req.body || {}; const entry = list().find(item => item.requestId === req.params.id);
    if (!entry) return res.status(404).json({ error: 'approval request is not pending' });
    if (body.sessionId !== entry.sessionId) return res.status(409).json({ error: 'sessionId does not match request source' });
    if (body.decision !== 'allow' && body.decision !== 'deny') return res.status(400).json({ error: 'decision must be allow or deny' });
    // The risk level of a permission is owned by the authoritative backend
    // policy (`src/approval/ApprovalPolicy.ts`). While the UI server cannot
    // obtain that value, an `allow` must not be granted here: the UI would
    // decide on a risk level nobody computed. `deny` always stays available.
    if (body.decision === 'allow') {
      const risk = entry.risk;
      if (entry.isElicitation) {
        if (risk && ['high', 'critical'].includes(risk)) return res.status(409).json({ error: 'high-risk approvals must be handled by the gateway policy' });
      } else {
        if (!risk) return res.status(409).json({ error: 'authoritative risk classification is unavailable; allow is refused', code: 'authoritative_risk_unavailable' });
        if (['high', 'critical'].includes(risk)) return res.status(409).json({ error: 'high-risk approvals must be handled by the gateway policy' });
      }
    }
    if (inFlight.has(entry.requestId)) return res.status(409).json({ error: 'approval request is already being decided' });
    if (entry.isElicitation) {
      if (body.decision === 'deny') {
        body.answers = { type: 'cancelled', reason: 'denied' };
      } else if (body.answers && typeof body.answers === 'object' && !Array.isArray(body.answers)) {
        body.answers = { type: 'answered', answers: body.answers };
      } else {
        return res.status(400).json({ error: 'answers must be an object' });
      }
    }
    inFlight.add(entry.requestId);
    try {
      const actor = req.user?.id ?? req.user?.userId;
      // The actor is the authenticated user of this request; the client body
      // never carries it. The provenance of the actor is set by the bridge
      // (`client_reported`), never by the caller.
      const delivered = entry.isElicitation ? await deps.respondElicitation?.(entry.sessionId, entry.requestId, body.answers, actor) : await deps.decidePermission?.(entry.requestId, body.decision, { sessionId: entry.sessionId, remember: Boolean(body.remember), ...(actor != null ? { actor: String(actor) } : {}) });
      if (!delivered) return res.status(502).json({ error: 'gateway did not acknowledge decision' });
      clearPendingPermission(entry.requestId);
      return res.json({ ok: true });
    } catch (e) { return res.status(502).json({ error: 'gateway decision failed' }); }
    finally { inFlight.delete(entry.requestId); }
  });
  return router;
}
export default createApprovalSessionRouter;
