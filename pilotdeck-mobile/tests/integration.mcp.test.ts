import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { test, expect } from 'vitest';
import { McpSession } from '../src/mcp/session';

async function endpoint(label: string) {
  let deleted = 0;
  const server = createServer(async (req, res) => {
    if (req.method === 'DELETE') { deleted++; res.writeHead(200); res.end(); return; }
    if (req.method === 'GET') { res.writeHead(405); res.end(); return; }
    let body = ''; for await (const chunk of req) body += String(chunk);
    const message = JSON.parse(body) as { id?: number; method: string };
    if (message.id === undefined) { res.writeHead(202); res.end(); return; }
    const result: Record<string, unknown> = {
      initialize: { protocolVersion: '2025-03-26', capabilities: { tools: {}, resources: {}, prompts: {} }, serverInfo: { name: label, version: '1.0' } },
      'tools/list': { tools: [{ name: label, inputSchema: { type: 'object' } }] },
      'tools/call': { content: [{ type: 'text', text: label }] },
      'resources/list': { resources: [{ name: label, uri: `test://${label}` }] },
      'resources/read': { contents: [{ uri: `test://${label}`, text: label }] },
      'prompts/list': { prompts: [{ name: label }] },
      'prompts/get': { messages: [{ role: 'user', content: { type: 'text', text: label } }] },
    };
    res.writeHead(200, { 'Content-Type': 'application/json', 'Mcp-Session-Id': label });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: result[message.method] }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); if (!address || typeof address === 'string') throw Error('port missing');
  return { url: `http://127.0.0.1:${address.port}/mcp`, server, deleted: () => deleted };
}
async function close(server: Server) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }

test('official SDK exercises tools resources prompts across twelve alternating real HTTP sessions', async () => {
  const a = await endpoint('alpha'); const b = await endpoint('beta');
  const client = new McpSession();
  try {
    for (let i = 0; i < 12; i++) {
      const target = i % 2 ? b : a; const label = i % 2 ? 'beta' : 'alpha';
      await client.connect(target.url, '', label);
      expect(client.status().phase).toBe('connected');
      for (const result of [await client.listTools(), await client.callTool(label, '{}'), await client.listResources(), await client.readResource(`test://${label}`), await client.listPrompts(), await client.getPrompt(label, '{}')]) {
        expect(JSON.stringify(result)).toContain(label);
        expect(JSON.stringify(result)).not.toContain(i % 2 ? 'alpha' : 'beta');
      }
    }
    await client.dispose();
    expect(a.deleted()).toBe(6); expect(b.deleted()).toBe(6);
  } finally { await client.dispose(); await close(a.server); await close(b.server); }
}, 15000);
