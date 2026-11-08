import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import http from 'node:http';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

// The approval binding lives in the pilot home. The tests must never read or
// write the real one.
const pilotHome = await vi.hoisted(async () => {
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    return mkdtempSync(join(tmpdir(), 'pilotdeck-approval-session-'));
});
vi.mock('../utils/pilotPaths.js', async (importOriginal) => ({ ...(await importOriginal()), resolvePilotHome: () => pilotHome }));

import { createApprovalSessionRouter } from './approval-session.js';

function requestJson(url, options = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const body = options.body ? JSON.stringify(options.body) : undefined;
    const req = http.request({ hostname: target.hostname, port: target.port, path: target.pathname, method: options.method || 'GET', headers: { ...(body ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } : {}) } }, res => {
      let text = ''; res.setEncoding('utf8'); res.on('data', chunk => { text += chunk; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = text ? JSON.parse(text) : null; } catch { /* preserve response text for diagnostics */ }
        resolve({ status: res.statusCode, body: parsed, text });
      });
    });
    req.on('error', reject); if (body) req.write(body); req.end();
  });
}

describe('approval session API', () => {
  beforeEach(() => {
    const file = path.join(pilotHome, 'approval-bindings.json');
    if (existsSync(file)) rmSync(file);
  });

  it('returns the fixed session envelope and redacted pending request', async () => {
    const router = createApprovalSessionRouter({
      listPending: () => [{ requestId: 'r1', sessionId: 's1', toolName: 'Bash', input: { token: 'secret', command: 'pwd' }, context: {}, isElicitation: false, createdAt: 10, updatedAt: 11 }],
      resolveProject: () => ({ projectName: 'Demo', projectKey: '/projects/demo' }),
      getBinding: () => ({ enabled: true, channelKey: 'feishu', chatId: 'c1', approverIds: ['u1'] }),
    });
    const app = express(); app.use(express.json()); app.use((req, _res, next) => { req.user = { id: 'authenticated-user' }; next(); }); app.use('/api/approval-session', router);
    const server = await new Promise(resolve => { const s = app.listen(0, () => resolve(s)); });
    const responseData = await requestJson(`http://127.0.0.1:${server.address().port}/api/approval-session`);
    server.close();
    expect(responseData.text).toContain('approval-center');
    expect(responseData.status).toBe(200);
    expect(responseData.body.session.id).toBe('approval-center');
    expect(responseData.body.requests[0]).toMatchObject({ id: 'r1', requestId: 'r1', sessionId: 's1', projectName: 'Demo', kind: 'permission', state: 'pending' });
    expect(JSON.stringify(responseData.body)).not.toContain('secret');
  });

  it('uses safe timestamp defaults and resolver metadata when fixture dates are absent', async () => {
    const router = createApprovalSessionRouter({ listPending: () => [{ requestId: 'r2', sessionId: 's2', context: {}, isElicitation: false }], resolveProject: () => ({ projectName: 'Real project', projectKey: '/real/project' }) });
    const app = express(); app.use(express.json()); app.use((req, _res, next) => { req.user = { id: 'authenticated-user' }; next(); }); app.use('/api/approval-session', router);
    const server = await new Promise(resolve => { const s = app.listen(0, () => resolve(s)); });
    const response = await requestJson(`http://127.0.0.1:${server.address().port}/api/approval-session`);
    server.close();
    expect(response.status).toBe(200);
    expect(response.body.requests[0]).toMatchObject({ projectName: 'Real project', projectKey: '/real/project', createdAt: '1970-01-01T00:00:00.000Z', updatedAt: '1970-01-01T00:00:00.000Z' });
  });

  it('accepts UI answers dictionaries and denies elicitation without answers', async () => {
    const respond = vi.fn().mockResolvedValue(true);
    const router = createApprovalSessionRouter({ listPending: () => [{ requestId: 'e1', sessionId: 's1', risk: 'low', context: {}, isElicitation: true }], respondElicitation: respond });
    const app = express(); app.use(express.json()); app.use((req, _res, next) => { req.user = { id: 'authenticated-user' }; next(); }); app.use('/api/approval-session', router);
    const server = await new Promise(resolve => { const s = app.listen(0, () => resolve(s)); });
    const base = `http://127.0.0.1:${server.address().port}/api/approval-session/requests/e1/decision`;
    expect((await requestJson(base, { method: 'POST', body: { sessionId: 's1', decision: 'allow', answers: { Q: 'A' } } })).status).toBe(200);
    expect(respond).toHaveBeenCalledWith('s1', 'e1', { type: 'answered', answers: { Q: 'A' } }, 'authenticated-user');
    server.close();
  });

  it('cancels denied elicitation without requiring answers', async () => {
    const respond = vi.fn().mockResolvedValue(true);
    const router = createApprovalSessionRouter({ listPending: () => [{ requestId: 'e2', sessionId: 's2', context: {}, isElicitation: true }], respondElicitation: respond });
    const app = express(); app.use(express.json()); app.use((req, _res, next) => { req.user = { id: 'authenticated-user' }; next(); }); app.use('/api/approval-session', router);
    const server = await new Promise(resolve => { const s = app.listen(0, () => resolve(s)); });
    const response = await requestJson(`http://127.0.0.1:${server.address().port}/api/approval-session/requests/e2/decision`, { method: 'POST', body: { sessionId: 's2', decision: 'deny' } });
    server.close();
    expect(response.status).toBe(200);
    expect(respond).toHaveBeenCalledWith('s2', 'e2', { type: 'cancelled', reason: 'denied' }, 'authenticated-user');
  });

  it('returns a gateway error without clearing a pending request when delivery fails', async () => {
    const decide = vi.fn().mockResolvedValue(false);
    const router = createApprovalSessionRouter({ listPending: () => [{ requestId: 'r3', sessionId: 's3', risk: 'low', context: {}, isElicitation: false }], decidePermission: decide });
    const app = express(); app.use(express.json()); app.use((req, _res, next) => { req.user = { id: 'authenticated-user' }; next(); }); app.use('/api/approval-session', router);
    const server = await new Promise(resolve => { const s = app.listen(0, () => resolve(s)); });
    const response = await requestJson(`http://127.0.0.1:${server.address().port}/api/approval-session/requests/r3/decision`, { method: 'POST', body: { sessionId: 's3', decision: 'allow' } });
    server.close();
    expect(response.status).toBe(502);
    expect(decide).toHaveBeenCalledOnce();
  });

  it('rejects unsupported channels and only invokes gateway after pending/session validation', async () => {
    const decide = vi.fn().mockResolvedValue(true);
    const router = createApprovalSessionRouter({ listPending: () => [{ requestId: 'r1', sessionId: 's1', toolName: 'Bash', input: {}, context: {}, isElicitation: false, createdAt: 1, updatedAt: 1 }], decidePermission: decide });
    const app = express(); app.use(express.json()); app.use((req, _res, next) => { req.user = { id: 'authenticated-user' }; next(); }); app.use('/api/approval-session', router);
    const server = await new Promise(resolve => { const s = app.listen(0, () => resolve(s)); });
    const base = `http://127.0.0.1:${server.address().port}/api/approval-session`;
    const unsupported = await requestJson(`${base}/channel`, { method: 'PUT', body: { enabled: true, channelKey: 'weixin', chatId: 'c', approverIds: [] } });
    const mismatch = await requestJson(`${base}/requests/r1/decision`, { method: 'POST', body: { sessionId: 'wrong', decision: 'allow' } });
    server.close();
    expect(unsupported.status).toBe(400);
    expect(mismatch.status).toBe(409);
    expect(decide).not.toHaveBeenCalled();
  });

  it('uses the authenticated actor and ignores a body-supplied actor', async () => {
    const decide = vi.fn().mockResolvedValue(true);
    const router = createApprovalSessionRouter({ listPending: () => [{ requestId: 'r4', sessionId: 's4', risk: 'medium', context: {}, isElicitation: false }], decidePermission: decide });
    const app = express(); app.use(express.json()); app.use((req, _res, next) => { req.user = { id: 'real-actor' }; next(); }); app.use('/api/approval-session', router);
    const server = await new Promise(resolve => { const s = app.listen(0, () => resolve(s)); });
    const response = await requestJson(`http://127.0.0.1:${server.address().port}/api/approval-session/requests/r4/decision`, { method: 'POST', body: { sessionId: 's4', decision: 'allow', actor: 'forged-actor' } });
    server.close();
    expect(response.status).toBe(200);
    // The provenance of the actor belongs to the bridge (`client_reported`).
    // `web_authenticated` is not a valid origin, so the route claims no origin
    // at all and forwards the authenticated user only.
    expect(decide).toHaveBeenCalledWith('r4', 'allow', expect.objectContaining({ actor: 'real-actor', sessionId: 's4' }));
    expect(decide.mock.calls[0][2]).not.toHaveProperty('actorSource');
    expect(decide.mock.calls[0][2]).not.toHaveProperty('forged-actor');
  });

  it('keeps an explicit disabled rebinding after disk state is unavailable', async () => {
    const saveBinding = vi.fn().mockResolvedValue({ enabled: false, channelKey: '', chatId: '', approverIds: [] });
    const router = createApprovalSessionRouter({ getBinding: () => ({ enabled: true, channelKey: 'feishu', chatId: 'old', approverIds: ['old-user'] }), saveBinding });
    const app = express(); app.use(express.json()); app.use('/api/approval-session', router);
    const server = await new Promise(resolve => { const s = app.listen(0, () => resolve(s)); });
    const base = `http://127.0.0.1:${server.address().port}/api/approval-session`;
    const disabled = await requestJson(`${base}/channel`, { method: 'PUT', body: { enabled: false, channelKey: '', chatId: '', approverIds: [] } });
    const restored = await requestJson(base);
    server.close();
    expect(disabled.status).toBe(200);
    expect(saveBinding).toHaveBeenCalledWith(expect.objectContaining({ enabled: false }));
    expect(restored.body.session.channelBinding).toMatchObject({ enabled: false, approverIds: [] });
  });

  it('rejects concurrent duplicate decisions for one pending request', async () => {
    let release;
    const decide = vi.fn().mockImplementation(() => new Promise(resolve => { release = resolve; }));
    const router = createApprovalSessionRouter({ listPending: () => [{ requestId: 'r5', sessionId: 's5', risk: 'medium', context: {}, isElicitation: false }], decidePermission: decide });
    const app = express(); app.use(express.json()); app.use('/api/approval-session', router);
    const server = await new Promise(resolve => { const s = app.listen(0, () => resolve(s)); });
    const url = `http://127.0.0.1:${server.address().port}/api/approval-session/requests/r5/decision`;
    const first = requestJson(url, { method: 'POST', body: { sessionId: 's5', decision: 'deny' } });
    await new Promise(resolve => setImmediate(resolve));
    const second = await requestJson(url, { method: 'POST', body: { sessionId: 's5', decision: 'deny' } });
    release(true);
    const firstResponse = await first;
    server.close();
    expect(second.status).toBe(409);
    expect(firstResponse.status).toBe(200);
    expect(decide).toHaveBeenCalledOnce();
  });

  it('never lets the client claim a channel identity', async () => {
    const decide = vi.fn().mockResolvedValue(true);
    const router = createApprovalSessionRouter({ listPending: () => [{ requestId: 'r6', sessionId: 's6', risk: 'medium', context: {}, isElicitation: false }], decidePermission: decide });
    const app = express(); app.use(express.json()); app.use((req, _res, next) => { req.user = { id: 'real-actor' }; next(); }); app.use('/api/approval-session', router);
    const server = await new Promise(resolve => { const s = app.listen(0, () => resolve(s)); });
    const response = await requestJson(`http://127.0.0.1:${server.address().port}/api/approval-session/requests/r6/decision`, { method: 'POST', body: { sessionId: 's6', decision: 'allow', actor: 'forged-actor', actorSource: 'channel_identity' } });
    server.close();
    expect(response.status).toBe(200);
    expect(decide.mock.calls[0][2]).not.toHaveProperty('actorSource');
    expect(decide.mock.calls[0][2].actor).toBe('real-actor');
  });

  it('refuses to allow a permission while the authoritative risk is unknown', async () => {
    const decide = vi.fn().mockResolvedValue(true);
    const router = createApprovalSessionRouter({ listPending: () => [{ requestId: 'r7', sessionId: 's7', toolName: 'Bash', input: {}, context: {}, isElicitation: false }], decidePermission: decide });
    const app = express(); app.use(express.json()); app.use((req, _res, next) => { req.user = { id: 'real-actor' }; next(); }); app.use('/api/approval-session', router);
    const server = await new Promise(resolve => { const s = app.listen(0, () => resolve(s)); });
    const base = `http://127.0.0.1:${server.address().port}/api/approval-session`;
    const allowed = await requestJson(`${base}/requests/r7/decision`, { method: 'POST', body: { sessionId: 's7', decision: 'allow' } });
    // The risk level belongs to the authoritative backend policy. As long as
    // the UI server cannot obtain it, an `allow` must not be granted here.
    expect(allowed.status).toBe(409);
    expect(allowed.body.code).toBe('authoritative_risk_unavailable');
    expect(decide).not.toHaveBeenCalled();
    // `deny` always stays available.
    const denied = await requestJson(`${base}/requests/r7/decision`, { method: 'POST', body: { sessionId: 's7', decision: 'deny' } });
    server.close();
    expect(denied.status).toBe(200);
    expect(decide).toHaveBeenCalledWith('r7', 'deny', expect.objectContaining({ sessionId: 's7' }));
  });

  it('shows an unknown risk as high and never returns the concrete payload', async () => {
    const router = createApprovalSessionRouter({ listPending: () => [{ requestId: 'r8', sessionId: 's8', toolName: 'Bash', input: { note: 'sk-live-1234567890' }, context: { detail: 'super-secret-token' }, isElicitation: false }] });
    const app = express(); app.use(express.json()); app.use('/api/approval-session', router);
    const server = await new Promise(resolve => { const s = app.listen(0, () => resolve(s)); });
    const response = await requestJson(`http://127.0.0.1:${server.address().port}/api/approval-session`);
    server.close();
    expect(response.status).toBe(200);
    expect(response.body.requests[0].risk).toBe('high');
    const serialized = JSON.stringify(response.body);
    expect(serialized).not.toContain('sk-live-1234567890');
    expect(serialized).not.toContain('super-secret-token');
    // Only the structure is reported: field names, never their values.
    expect(response.body.requests[0].input).toEqual({ present: true, type: 'object', fields: ['note'] });
    expect(response.body.requests[0].context).toEqual({ present: true, type: 'object', fields: ['detail'] });
  });

  it('refuses to enable a binding without approvers', async () => {
    const router = createApprovalSessionRouter({});
    const app = express(); app.use(express.json()); app.use('/api/approval-session', router);
    const server = await new Promise(resolve => { const s = app.listen(0, () => resolve(s)); });
    const base = `http://127.0.0.1:${server.address().port}/api/approval-session`;
    const empty = await requestJson(`${base}/channel`, { method: 'PUT', body: { enabled: true, channelKey: 'feishu', chatId: 'chat-1', approverIds: [] } });
    const blank = await requestJson(`${base}/channel`, { method: 'PUT', body: { enabled: true, channelKey: 'feishu', chatId: 'chat-1', approverIds: ['  '] } });
    const valid = await requestJson(`${base}/channel`, { method: 'PUT', body: { enabled: true, channelKey: 'feishu', chatId: 'chat-1', approverIds: ['alice'] } });
    server.close();
    expect(empty.status).toBe(400);
    expect(blank.status).toBe(400);
    expect(valid.status).toBe(200);
    expect(valid.body.session.channelBinding).toMatchObject({ enabled: true, approverIds: ['alice'] });
  });

  it('treats a stored binding without approvers as disabled', async () => {
    writeFileSync(path.join(pilotHome, 'approval-bindings.json'), JSON.stringify({ bindings: [{ channelKey: 'feishu', chatId: 'chat-1', approverIds: [], approvalSession: 'approval-center', approvalSource: 'approval-center' }] }));
    const router = createApprovalSessionRouter({});
    const app = express(); app.use(express.json()); app.use('/api/approval-session', router);
    const server = await new Promise(resolve => { const s = app.listen(0, () => resolve(s)); });
    const response = await requestJson(`http://127.0.0.1:${server.address().port}/api/approval-session`);
    server.close();
    expect(response.status).toBe(200);
    expect(response.body.session.channelBinding).toMatchObject({ enabled: false, approverIds: [] });
  });
});
