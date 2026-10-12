import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { createGateway } from '../src/gateway.js';

async function listen(server: Server): Promise<string> {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing port');
  return `http://127.0.0.1:${address.port}`;
}

async function fixture(fn: (url: string, received: Array<{ method: string; path: string; headers: Record<string, string | string[] | undefined>; body: string }>) => Promise<void>) {
  const received: Array<{ method: string; path: string; headers: Record<string, string | string[] | undefined>; body: string }> = [];
  let count = 0;
  const upstream = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk.toString();
    received.push({ method: req.method!, path: req.url!, headers: req.headers, body });
    if (req.method === 'POST' && !req.headers['mcp-session-id']) {
      res.setHeader('Mcp-Session-Id', `upstream-${++count}`);
      res.setHeader('Content-Type', 'application/json');
      res.end('{"jsonrpc":"2.0","result":{}}');
    } else if (req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      res.write('id: event-1\ndata: {"jsonrpc":"2.0","method":"ping"}\n\n');
      setTimeout(() => res.end('id: event-2\ndata: {"jsonrpc":"2.0","method":"pong"}\n\n'), 30);
    } else {
      res.writeHead(req.method === 'DELETE' ? 200 : 202);
      res.end();
    }
  });
  const upstreamUrl = await listen(upstream);
  const gateway = createGateway({ instances: { alpha: upstreamUrl + '/mcp', beta: upstreamUrl + '/other' }, allowedOrigins: ['http://localhost:3000'], sessionTtlMs: 60_000 });
  const gatewayUrl = await listen(gateway);
  try { await fn(gatewayUrl, received); }
  finally { gateway.closeAllConnections(); upstream.closeAllConnections(); await Promise.all([new Promise<void>(r => gateway.close(() => r())), new Promise<void>(r => upstream.close(() => r()))]); }
}

test('permits allowlisted browser preflight and exposes session headers', async () => {
  await fixture(async (base, received) => {
    const result = await fetch(`${base}/mcp/alpha`, { method: 'OPTIONS', headers: { Origin: 'http://localhost:3000', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,mcp-session-id' } });
    assert.equal(result.status, 204);
    assert.match(result.headers.get('access-control-allow-headers') ?? '', /authorization/i);
    assert.match(result.headers.get('access-control-expose-headers') ?? '', /mcp-session-id/i);
    assert.equal(received.length, 0);
    assert.equal((await fetch(`${base}/mcp/alpha`, { method: 'OPTIONS', headers: { Origin: 'http://evil.test' } })).status, 403);
  });
});

test('rejects invalid session capacity configuration', () => {
  assert.throws(() => createGateway({ instances: {}, allowedOrigins: [], sessionTtlMs: 1000, maxSessions: 0 }), /maxSessions/);
});

const headers = { Origin: 'http://localhost:3000', Accept: 'application/json, text/event-stream', Authorization: 'Bearer test-secret', 'Content-Type': 'application/json', 'MCP-Protocol-Version': '2025-06-18' };

test('isolates opaque sessions across instances and relays POST/DELETE without replay', async () => {
  await fixture(async (base, received) => {
    const init = (id: string) => fetch(`${base}/mcp/${id}`, { method: 'POST', headers, body: '{"method":"initialize"}' });
    const a = await init('alpha'); const b = await init('beta');
    const sa = a.headers.get('mcp-session-id')!; const sb = b.headers.get('mcp-session-id')!;
    assert.ok(sa && sb && sa !== sb && !sa.startsWith('upstream-') && !sb.startsWith('upstream-'));
    assert.equal((await a.text()), '{"jsonrpc":"2.0","result":{}}'); await b.text();
    const post = await fetch(`${base}/mcp/alpha`, { method: 'POST', headers: { ...headers, 'Mcp-Session-Id': sa }, body: '{"method":"tools/call"}' });
    assert.equal(post.status, 202);
    assert.equal(received.at(-1)?.headers['mcp-session-id'], 'upstream-1');
    assert.equal(received.at(-1)?.headers.authorization, 'Bearer test-secret');
    assert.equal(received.at(-1)?.headers['mcp-protocol-version'], '2025-06-18');
    assert.equal(received.at(-1)?.body, '{"method":"tools/call"}');
    const mismatch = await fetch(`${base}/mcp/beta`, { method: 'POST', headers: { ...headers, 'Mcp-Session-Id': sa }, body: '{}' });
    assert.equal(mismatch.status, 404);
    const del = await fetch(`${base}/mcp/alpha`, { method: 'DELETE', headers: { ...headers, 'Mcp-Session-Id': sa } });
    assert.equal(del.status, 200);
    assert.equal(received.at(-1)?.headers['mcp-session-id'], 'upstream-1');
    assert.equal((await fetch(`${base}/mcp/alpha`, { method: 'GET', headers: { ...headers, 'Mcp-Session-Id': sa } })).status, 404);
    assert.equal(received.filter(r => r.body.includes('tools/call')).length, 1);
  });
});

test('streams GET SSE including event ids and relays resume header', async () => {
  await fixture(async (base, received) => {
    const init = await fetch(`${base}/mcp/alpha`, { method: 'POST', headers, body: '{}' });
    const sid = init.headers.get('mcp-session-id')!; await init.text();
    const stream = await fetch(`${base}/mcp/alpha`, { headers: { ...headers, 'Mcp-Session-Id': sid, 'Last-Event-ID': 'prior-7' } });
    assert.equal(stream.headers.get('content-type'), 'text/event-stream');
    const reader = stream.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    assert.match(first, /event-1/);
    assert.match(await new Response(new ReadableStream({ async start(controller) { for (;;) { const v = await reader.read(); if (v.done) break; controller.enqueue(v.value); } controller.close(); } })).text(), /event-2/);
    assert.equal(received.at(-1)?.headers['last-event-id'], 'prior-7');
  });
});

test('rejects bad origins, unknown instances and reports process-only health', async () => {
  await fixture(async (base, received) => {
    assert.equal((await fetch(`${base}/mcp/alpha`, { method: 'POST', headers: { ...headers, Origin: 'http://evil.test' }, body: '{}' })).status, 403);
    assert.equal((await fetch(`${base}/mcp/not-configured`, { method: 'POST', headers, body: '{}' })).status, 404);
    assert.deepEqual(await (await fetch(`${base}/health`)).json(), { status: 'ok', upstream: 'not_checked' });
    assert.equal(received.length, 0);
  });
});
