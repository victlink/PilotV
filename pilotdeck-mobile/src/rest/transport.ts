export function restPath(...segments: string[]): string {
  return `/api/${segments.map(encodeURIComponent).join('/')}`;
}

type Method = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';

export class UiRestTransport {
  private readonly pending = new Set<AbortController>();
  constructor(readonly origin: string, private jwt = '', private apiKey = '') {
    const url = new URL(origin);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
      throw new Error('UI REST origin must be an HTTP(S) origin without credentials, path or query');
    }
  }
  abortPending(): void {
    for (const controller of this.pending) controller.abort();
    this.pending.clear();
  }
  dispose(): void {
    this.abortPending();
    this.jwt = '';
    this.apiKey = '';
  }
  setCredentials(jwt: string, apiKey: string): void { this.jwt = jwt; this.apiKey = apiKey; }
  private async request(method: Method, path: string, body?: object | FormData, signal?: AbortSignal, authenticated = true): Promise<Response> {
    if (!path.startsWith('/api/') || path.startsWith('//') || path.includes('#')) throw new Error('Invalid REST path');
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) controller.abort();
    this.pending.add(controller);
    try {
      const headers: Record<string, string> = {};
      if (!(body instanceof FormData) && body !== undefined) headers['Content-Type'] = 'application/json';
      if (authenticated && this.jwt) headers.Authorization = `Bearer ${this.jwt}`;
      if (authenticated && this.apiKey) headers['x-api-key'] = this.apiKey;
      const response = await fetch(new URL(path, this.origin), { method, headers, body: body instanceof FormData ? body : body === undefined ? undefined : JSON.stringify(body), signal: controller.signal });
      if (!response.ok) {
        const text = await response.text();
        let message = response.statusText;
        try {
          const parsed: unknown = JSON.parse(text);
          if (typeof parsed === 'object' && parsed !== null && 'error' in parsed) {
            const error = parsed.error;
            if (typeof error === 'string') message = error;
          }
        } catch { /* response may not be JSON */ }
        throw new Error(`${response.status}: ${message}`);
      }
      return response;
    } finally {
      this.pending.delete(controller);
      signal?.removeEventListener('abort', abort);
    }
  }
  async json(method: Method, path: string, body?: object, signal?: AbortSignal): Promise<unknown> {
    const response = await this.request(method, path, body, signal);
    if (response.status === 204) return null;
    const text = await response.text();
    if (!text) return null;
    return JSON.parse(text) as unknown;
  }
  async login(username: string, password: string, signal?: AbortSignal): Promise<unknown> {
    const response = await this.request('POST', '/api/auth/login', { username, password }, signal, false);
    return response.json() as Promise<unknown>;
  }
  upload(project: string, targetPath: string, file: File, signal?: AbortSignal): Promise<unknown> {
    const form = new FormData();
    form.append('targetPath', targetPath);
    form.append('relativePaths', JSON.stringify([file.name]));
    form.append('sizes', JSON.stringify([file.size]));
    form.append('files', file);
    return this.request('POST', restPath('projects', project, 'files', 'upload'), form, signal).then(async response => response.json() as Promise<unknown>);
  }
  download(project: string, signal?: AbortSignal): Promise<Blob> {
    return this.request('GET', restPath('projects', project, 'download'), undefined, signal).then(response => response.blob());
  }
}
