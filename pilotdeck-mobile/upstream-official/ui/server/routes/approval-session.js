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
 * The authoritative policy module is shared with the native approval center
 * (`src/approval/ApprovalPolicy.ts`). It is loaded lazily so a runtime that
 * cannot resolve the TypeScript source keeps serving instead of failing to
 * boot; in that case the risk stays unknown and `allow` is refused.
 */
let policyPromise = null;
function loadPolicy() {
  if (!policyPromise) {
    policyPromise = import('../../../src/approval/ApprovalPolicy.js')
      .catch((error) => { console.warn('[approval-session] authoritative policy unavailable:', error?.message || error); return null; });
  }
  return policyPromise;
}

/**
 * The risk of a pending request is owned by the backend policy, never by the
 * browser. A gateway delivered value wins; otherwise the very same module the
 * native approval center uses computes it from the tool name and the payload.
 */
function authoritativeRisk(entry, policy) {
  if (entry.risk) return entry.risk;
  if (!policy) return undefined;
  return policy.classifyApprovalRisk({ kind: entry.isElicitation ? 'elicitation' : 'permission', toolName: entry.toolName || '', payload: entry.input });
}

/**
 * The concrete request content is reported through the authoritative
 * redactor, so the reviewer sees what is being asked for while credentials
 * and other sensitive values stay masked. The raw payload is never echoed.
 */
function payloadPreviewOf(entry, policy) {
  if (!policy || entry.input === undefined || entry.input === null) return { preview: '', redacted: false };
  const result = policy.redactPayload(entry.input);
  return { preview: result.preview || '', redacted: Boolean(result.redacted) };
}

/**
 * A structural copy of the payload where sensitive values are masked. It
 * reuses the authoritative detectors of the shared policy module, so the
 * reviewer can read the question and the offered options of an elicitation
 * while credentials stay masked.
 */
function sanitizedInput(value, policy, key = '', depth = 0) {
  if (!policy || value === null || value === undefined) return undefined;
  if (depth > 6) return null;
  if (Array.isArray(value)) return value.slice(0, 50).map(item => sanitizedInput(item, policy, key, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const [childKey, childValue] of Object.entries(value).slice(0, 50)) out[childKey] = sanitizedInput(childValue, policy, childKey, depth + 1);
    return out;
  }
  if (typeof value === 'string') {
    if (policy.isSensitiveKey(key)) return '[redacted]';
    if (policy.looksLikeCredential(value)) return '[redacted]';
    return value.length > 600 ? `${value.slice(0, 600)}…` : value;
  }
  return value;
}

/**
 * Structure only: the field names of a payload, never their values. It is
 * used for the request context, which is not part of the reviewed request.
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
async function mapRequest(entry, resolveProject, policy) {
  const project = projectOf(entry, await resolveProject?.(entry));
  const risk = authoritativeRisk(entry, policy);
  const preview = payloadPreviewOf(entry, policy);
  return { id: entry.requestId, requestId: entry.requestId, sessionId: entry.sessionId, ...project,
    kind: entry.isElicitation ? 'elicitation' : 'permission', toolName: entry.toolName || 'unknown',
    summary: entry.summary || (entry.isElicitation ? '业务确认' : `工具授权：${entry.toolName || 'unknown'}`),
    // An elicitation is answered by choosing an offered option, so its
    // structure has to survive; the values are masked by the shared policy.
    input: entry.isElicitation ? sanitizedInput(entry.input, policy) : safeShape(entry.input), context: safeShape(entry.context),
    payloadPreview: preview.preview, payloadRedacted: preview.redacted,
    createdAt: safeTimestamp(entry.createdAt),
    updatedAt: safeTimestamp(entry.updatedAt), state: 'pending',
    // An unknown risk is displayed as `high`: the UI must never suggest a
    // lower risk than the authoritative policy would compute.
    risk: risk || 'high', expiresAt: safeTimestamp(Number.isFinite(entry.expiresAt) ? entry.expiresAt : Date.parse(safeTimestamp(entry.createdAt)) + 45 * 60 * 1000) };
}
function validateBinding(body) {
  if (!body || typeof body.enabled !== 'boolean') return 'enabled must be boolean';
  if (body.enabled && !CHANNELS.has(String(body.channelKey || '').trim())) return 'channelKey must be feishu or wecom; weixin is unsupported';
  // `chatId` is optional per the shared approval contract: when it is absent
  // the binding accepts an answer from any chat of the channel. The settings
  // UI only picks an already configured channel, so it may omit both IDs.
  if (body.chatId !== undefined && typeof body.chatId !== 'string') return 'chatId must be a string when provided';
  if (!Array.isArray(body.approverIds) || body.approverIds.some(v => typeof v !== 'string' || !v.trim())) return 'approverIds must be non-empty strings[]';
  // An enabled binding without approvers lets anybody in the bound chat
  // answer: the native `checkImBinding` only enforces the list when it is not
  // empty. Enabling therefore requires at least one approver id — the server
  // supplies the authenticated account when the client omits the field.
  if (body.enabled && body.approverIds.length === 0) return 'approverIds must list at least one approver when the binding is enabled';
  return null;
}
/**
 * A channel-only save (Settings → Approval Channel) omits both ids. Fill in
 * the approver allow-list from the authenticated local account so the binding
 * stays fail-closed, and drop an empty chatId so the shared contract treats it
 * as "any chat of this channel". Explicit values are always preserved.
 */
function normalizeChannelBody(body, user) {
  if (!body || typeof body !== 'object') return body;
  const next = { ...body };
  if (!Object.prototype.hasOwnProperty.call(next, 'approverIds')) {
    const actor = [user?.username, user?.id]
      .find(v => (typeof v === 'string' || typeof v === 'number') && String(v).trim());
    next.approverIds = [String(actor ?? 'local-user').trim()];
  }
  if (typeof next.chatId !== 'string' || !next.chatId.trim()) delete next.chatId;
  return next;
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
  const chatId = String(binding.chatId ?? '').trim();
  if (binding.enabled) {
    const record = { channelKey: binding.channelKey.trim(), approverIds: binding.approverIds.map(v => v.trim()), approvalSession: 'approval-center', approvalSource: 'approval-center' };
    // Omit chatId entirely when empty: the shared contract reads a missing
    // chatId as "any chat of this channel".
    if (chatId) record.chatId = chatId;
    bindings.push(record);
  }
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await fsp.writeFile(temp, JSON.stringify({ bindings }, null, 2), { mode: 0o600 });
  await fsp.rename(temp, file);
  return { enabled: binding.enabled, channelKey: binding.enabled ? binding.channelKey.trim() : '', chatId: binding.enabled ? chatId : '', approverIds: binding.enabled ? binding.approverIds.map(v => v.trim()) : [] };
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
    const policy = await loadPolicy();
    const requests = await Promise.all(list().map(entry => mapRequest(entry, deps.resolveProject, policy)));
    return res.json({ session: { ...session, channelBinding: binding }, requests });
  });
  router.put('/channel', async (req, res) => {
    const body = normalizeChannelBody(req.body, req.user);
    const error = validateBinding(body);
    if (error) return res.status(400).json({ error });
    try {
      binding = await (deps.saveBinding ? deps.saveBinding(body) : writeBinding(body));
      return res.json({ session: { ...session, channelBinding: binding } });
    } catch (e) { return res.status(500).json({ error: '审批绑定保存失败' }); }
  });
  router.post('/requests/:id/decision', async (req, res) => {
    const body = req.body || {}; const entry = list().find(item => item.requestId === req.params.id);
    if (!entry) return res.status(404).json({ error: 'approval request is not pending' });
    if (body.sessionId !== entry.sessionId) return res.status(409).json({ error: 'sessionId does not match request source' });
    if (body.decision !== 'allow' && body.decision !== 'deny') return res.status(400).json({ error: 'decision must be allow or deny' });
    // The risk level of a permission is owned by the authoritative backend
    // policy (`src/approval/ApprovalPolicy.ts`), never by the browser. The
    // risk is computed here from the very same module the native approval
    // center uses, so an `allow` is granted against a real classification.
    // High and critical requests stay in the source session, where the
    // native authorization surface handles them (contract §3). `deny` always
    // stays available.
    if (body.decision === 'allow') {
      const policy = await loadPolicy();
      const risk = authoritativeRisk(entry, policy);
      if (!risk) return res.status(409).json({ error: 'authoritative risk classification is unavailable; allow is refused', code: 'authoritative_risk_unavailable' });
      if (['high', 'critical'].includes(risk)) return res.status(409).json({ error: 'high-risk approvals must be handled by the gateway policy', code: 'high_risk_requires_source_session' });
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
