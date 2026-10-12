import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { randomBytes } from 'node:crypto';

export interface GatewayConfig {
  instances: Record<string, string>;
  allowedOrigins: string[];
  sessionTtlMs: number;
  maxSessions?: number;
}

type Session = { instance: string; upstreamId: string; expires: number };
const hop = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'host', 'content-length']);
function headersFrom(source: IncomingHttpHeaders): Headers {
  const result = new Headers();
  for (const [name, value] of Object.entries(source)) {
    if (hop.has(name) || name === 'cookie' || name === 'origin' || name === 'mcp-session-id' || name === 'accept-encoding' || value === undefined) continue;
    result.set(name, Array.isArray(value) ? value.join(', ') : value);
  }
  result.set('accept-encoding', 'identity');
  return result;
}
function reply(res: import('node:http').ServerResponse, status: number, text: string) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(text);
}

/** Transport relay only: never parses JSON-RPC messages or persists credentials. */
export function createGateway(config: GatewayConfig): Server {
  if (!Number.isFinite(config.sessionTtlMs) || config.sessionTtlMs <= 0) throw new Error('sessionTtlMs must be positive');
  const maxSessions = config.maxSessions ?? 1000;
  if (!Number.isSafeInteger(maxSessions) || maxSessions < 1) throw new Error('maxSessions must be a positive integer');
  const targets = new Map<string, string>();
  for (const [id, address] of Object.entries(config.instances)) {
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error('invalid instance ID');
    const url = new URL(address);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) throw new Error('invalid upstream URL');
    targets.set(id, url.href);
  }
  const allowed = new Set(config.allowedOrigins.map(origin => new URL(origin).origin));
  const sessions = new Map<string, Session>();
  return createServer(async (req, res) => {
    const path = (req.url ?? '').split('?')[0];
    if (path === '/health' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ status: 'ok', upstream: 'not_checked' }));
      return;
    }
    const match = /^\/mcp\/([a-zA-Z0-9_-]+)$/.exec(path);
    if (!match || !targets.has(match[1])) return reply(res, 404, 'Not found');
    if (!['POST', 'GET', 'DELETE', 'OPTIONS'].includes(req.method ?? '')) return reply(res, 405, 'Method not allowed');
    const origin = req.headers.origin;
    if (origin) {
      let accepted = false;
      try { accepted = allowed.has(new URL(origin).origin) || new URL(origin).host === req.headers.host && new URL(origin).protocol === 'http:'; } catch { /* invalid origin */ }
      if (!accepted) return reply(res, 403, 'Origin denied');
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    }
    res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id, MCP-Protocol-Version');
    if (req.method === 'OPTIONS') {
      const method = req.headers['access-control-request-method'];
      if (!origin || typeof method !== 'string' || !['POST', 'GET', 'DELETE'].includes(method)) return reply(res, 400, 'Invalid preflight');
      res.setHeader('Access-Control-Allow-Methods', 'POST, GET, DELETE');
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Accept, Mcp-Session-Id, MCP-Protocol-Version, Last-Event-ID');
      res.writeHead(204); res.end(); return;
    }
    const id = req.headers['mcp-session-id'];
    if (Array.isArray(id)) return reply(res, 400, 'Invalid session');
    let session: Session | undefined;
    if (id) {
      session = sessions.get(id);
      if (!session || session.instance !== match[1] || session.expires <= Date.now()) {
        if (session?.expires !== undefined && session.expires <= Date.now()) sessions.delete(id);
        return reply(res, 404, 'Unknown session');
      }
      session.expires = Date.now() + config.sessionTtlMs;
    }
    for (const [key, entry] of sessions) if (entry.expires <= Date.now()) sessions.delete(key);
    if (!session && req.method === 'POST' && sessions.size >= maxSessions) return reply(res, 503, 'Session capacity reached');
    const headers = headersFrom(req.headers);
    if (session) headers.set('Mcp-Session-Id', session.upstreamId);
    const abort = new AbortController();
    res.on('close', () => { if (!res.writableFinished) abort.abort(); });
    try {
      const upstream = await fetch(targets.get(match[1])!, {
        method: req.method,
        headers,
        body: req.method === 'POST' ? Readable.toWeb(req) as ReadableStream : undefined,
        duplex: req.method === 'POST' ? 'half' : undefined,
        signal: abort.signal,
        redirect: 'manual'
      } as RequestInit & { duplex?: 'half' });
      if (session && (upstream.status === 404 || req.method === 'DELETE')) sessions.delete(id!);
      const responseHeaders: Record<string, string> = {};
      upstream.headers.forEach((value, name) => {
        if (hop.has(name) || name === 'content-encoding' || name === 'access-control-allow-origin' || name === 'mcp-session-id' || name === 'set-cookie' || name === 'location') return;
        responseHeaders[name] = value;
      });
      responseHeaders['cache-control'] = 'no-store';
      const upstreamId = upstream.headers.get('mcp-session-id');
      if (upstreamId && !session) {
        if (sessions.size >= maxSessions) {
          await upstream.body?.cancel();
          return reply(res, 503, 'Session capacity reached');
        }
        const opaque = randomBytes(32).toString('base64url');
        sessions.set(opaque, { instance: match[1], upstreamId, expires: Date.now() + config.sessionTtlMs });
        responseHeaders['mcp-session-id'] = opaque;
      } else if (session && upstreamId) {
        // Never expose the upstream's internal session ID.
        responseHeaders['mcp-session-id'] = id!;
        session.upstreamId = upstreamId;
      }
      res.writeHead(upstream.status, responseHeaders);
      if (upstream.body) await pipeline(Readable.fromWeb(upstream.body as import('node:stream/web').ReadableStream), res);
      else res.end();
    } catch {
      if (!res.headersSent && !res.destroyed) reply(res, 502, 'Upstream unavailable');
      else res.destroy();
    }
  });
}
