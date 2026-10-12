import { createGateway } from './gateway.js';

function load() {
  const raw = process.env.MCP_UPSTREAMS;
  if (!raw) throw new Error('MCP_UPSTREAMS required: JSON map of instance IDs to fixed upstream URLs');
  const instances: unknown = JSON.parse(raw);
  if (!instances || typeof instances !== 'object' || Array.isArray(instances) || !Object.keys(instances).length || Object.values(instances).some(x => typeof x !== 'string')) throw new Error('MCP_UPSTREAMS must be a nonempty JSON object of URLs');
  const port = Number(process.env.PORT ?? 8765);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be 1-65535');
  return { instances: instances as Record<string, string>, port, host: process.env.HOST ?? '127.0.0.1', allowedOrigins: (process.env.ALLOWED_ORIGINS ?? '').split(',').map(x => x.trim()).filter(Boolean), sessionTtlMs: Number(process.env.SESSION_TTL_MS ?? 30 * 60_000) };
}

const { port, host, ...config } = load();
createGateway(config).listen(port, host, () => console.log(`MCP gateway listening on ${host}:${port}`));
