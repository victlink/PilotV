// The store records the owning session as "<channel>:<sessionKey>" (for example
// "web:s_6cd5..."), so compare the session segment instead of the whole value.
export function ownsSession(runId: unknown, sessionId: string): boolean {
  if (typeof runId !== 'string' || !sessionId) return false;
  const segment = runId.includes(':') ? runId.slice(runId.lastIndexOf(':') + 1) : runId;
  return segment === sessionId || runId === sessionId;
}

export type Artifact = {
  id: string;
  run_id?: string | null;
  title?: string | null;
  file_name?: string | null;
  source_path?: string | null;
  kind?: string | null;
  mime?: string | null;
};

export type MediaType = 'image' | 'audio' | 'video' | 'iframe' | 'model3d' | 'drawing' | 'unsupported';

export function mediaType(artifact: Artifact): MediaType {
  const mime = (artifact.mime || '').split(';', 1)[0].trim().toLowerCase();
  const ext = (artifact.file_name || artifact.source_path || '').split(/[?#]/, 1)[0].toLowerCase().match(/\.[^.\/]+$/)?.[0] || '';
  // A declared complex format must not be mistaken for a simple image or document.
  if (artifact.kind === 'model3d' || ['.glb', '.gltf', '.obj', '.stl'].includes(ext)) return 'model3d';
  if (artifact.kind === 'drawing' && ext !== '.pdf' && ext !== '.svg' && mime !== 'application/pdf' && mime !== 'image/svg+xml') return 'drawing';
  if (mime === 'application/pdf' || ext === '.pdf' || mime === 'text/html' || ext === '.html' || ext === '.htm') return 'iframe';
  if (mime.startsWith('image/') || ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg', '.avif'].includes(ext)) return 'image';
  if (mime.startsWith('audio/') || ['.mp3', '.wav', '.ogg', '.m4a', '.flac'].includes(ext)) return 'audio';
  if (mime.startsWith('video/') || ['.mp4', '.webm', '.mov'].includes(ext)) return 'video';
  if (mime.startsWith('text/') || ['.txt', '.md', '.csv', '.json', '.log'].includes(ext)) return 'iframe';
  return 'unsupported';
}

export async function listSessionArtifacts(sessionId: string, signal: AbortSignal): Promise<Artifact[]> {
  const matches: Artifact[] = [];
  for (let page = 0; page < 20; page++) {
    const response = await fetch(`/api/artifacts?limit=200&offset=${page * 200}`, { signal });
    if (!response.ok) throw new Error(`成果列表请求失败（HTTP ${response.status}）`);
    const data: unknown = await response.json();
    if (!data || typeof data !== 'object' || !('artifacts' in data) || !Array.isArray(data.artifacts)) {
      throw new Error('成果列表响应格式错误');
    }
    const items = data.artifacts as unknown[];
    if (items.length > 200) throw new Error('成果列表响应超过单页上限');
    for (const item of items) {
      if (item && typeof item === 'object' && 'id' in item && typeof item.id === 'string' &&
          'run_id' in item && ownsSession(item.run_id, sessionId)) matches.push(item as Artifact);
    }
    if (items.length < 200) return matches;
  }
  throw new Error('成果列表超过 20 页上限，无法保证当前会话成果完整；请缩小列表后刷新');
}
