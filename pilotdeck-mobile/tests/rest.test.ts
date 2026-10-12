import { afterEach, expect, it, vi } from 'vitest';
import { UiRestTransport, restPath } from '../src/rest/transport';

afterEach(() => vi.unstubAllGlobals());

it('keeps UI JWT separate from gateway credentials and encodes project paths', async () => {
  const fetcher = vi.fn(async (_url: string, _options: RequestInit) => new Response(JSON.stringify({ success: true }), { headers: { 'Content-Type': 'application/json' } }));
  vi.stubGlobal('fetch', fetcher);
  const client = new UiRestTransport('https://ui.example/', 'ui-jwt', 'ui-key');
  await client.json('GET', restPath('projects', 'a/b ?#', 'files'));
  const [url, options] = fetcher.mock.calls[0];
  expect(String(url)).toBe('https://ui.example/api/projects/a%2Fb%20%3F%23/files');
  expect(options.headers).toMatchObject({ Authorization: 'Bearer ui-jwt', 'x-api-key': 'ui-key' });
  expect(JSON.stringify(options)).not.toContain('gateway');
});

it('login never includes previous JWT or api key and reports server errors', async () => {
  const fetcher = vi.fn(async (_url: string, _options: RequestInit) => new Response(JSON.stringify({ error: 'denied' }), { status: 401, headers: { 'Content-Type': 'application/json' } }));
  vi.stubGlobal('fetch', fetcher);
  const client = new UiRestTransport('http://localhost:3001', 'old-jwt', 'old-key');
  await expect(client.login('user', 'password')).rejects.toThrow('401: denied');
  const options = fetcher.mock.calls[0][1] as RequestInit;
  expect(options.headers).toEqual({ 'Content-Type': 'application/json' });
  expect(options.body).toBe(JSON.stringify({ username: 'user', password: 'password' }));
});

it('aborts pending requests and does not manufacture JSON for binary downloads', async () => {
  const fetcher = vi.fn((_url: string, options: RequestInit) => new Promise<Response>((_resolve, reject) => {
    options.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
  }));
  vi.stubGlobal('fetch', fetcher);
  const client = new UiRestTransport('http://localhost:3001', 'jwt');
  const pending = client.json('GET', '/api/projects');
  client.dispose();
  await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  expect(fetcher.mock.calls[0][1].signal?.aborted).toBe(true);
});

it('multipart uses actual files field and leaves boundary to browser', async () => {
  const fetcher = vi.fn(async (_url: string, _options: RequestInit) => new Response('{}', { headers: { 'Content-Type': 'application/json' } }));
  vi.stubGlobal('fetch', fetcher);
  const client = new UiRestTransport('https://ui.example', 'jwt');
  const file = new File(['hello'], 'note.txt');
  await client.upload('project', '', file);
  const options = fetcher.mock.calls[0][1] as RequestInit;
  const form = options.body as FormData;
  expect(form.get('files')).toBe(file);
  expect(form.get('targetPath')).toBe('');
  expect(form.get('relativePaths')).toBe('["note.txt"]');
  expect(form.get('sizes')).toBe('[5]');
  expect(options.headers).not.toHaveProperty('Content-Type');
});
