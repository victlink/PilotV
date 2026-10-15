// Session artifacts come from the console's workspace endpoint: it attributes each
// artifact to a session the way the reviewer sees it (publish-time run id plus the
// project directory its source file lives in). Matching on run_id alone dropped
// everything attributed by path, which is why a session could look empty.
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
  status?: string | null;
  entry?: { url?: string | null; thumb_url?: string | null } | null;
  open_notes?: number | null;
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

type WorkspaceProject = { id?: string | null; sessions?: WorkspaceSession[] | null };
type WorkspaceSession = { id?: string | null; artifacts?: Artifact[] | null };

export async function loadSessionArtifacts(sessionId: string, signal: AbortSignal): Promise<Artifact[]> {
  const response = await fetch('/api/artifacts/workspace', { signal });
  if (!response.ok) throw new Error(`成果列表请求失败（HTTP ${response.status}）`);
  const data: unknown = await response.json();
  const projects = data && typeof data === 'object' && 'projects' in data && Array.isArray(data.projects)
    ? data.projects as WorkspaceProject[] : [];
  for (const project of projects) {
    if (!project || !Array.isArray(project.sessions)) continue;
    for (const session of project.sessions) {
      if (!session || typeof session.id !== 'string') continue;
      if (session.id !== sessionId && !ownsSession(session.id, sessionId)) continue;
      return Array.isArray(session.artifacts) ? session.artifacts : [];
    }
  }
  return [];
}

/** Stored file of an artifact; the workspace carries the console's own url for it. */
export function artifactRawUrl(artifact: Artifact): string {
  return artifact.entry?.url || `/api/artifacts/${encodeURIComponent(artifact.id)}/raw`;
}

/** 会话 id 去掉 `web:` 这类前缀后的裸 id：侧栏和成果台对同一个会话的写法可能不同。 */
const bareSessionId = (sessionId: string): string =>
  sessionId.includes(':') ? sessionId.slice(sessionId.lastIndexOf(':') + 1) : sessionId;

/**
 * 每个会话有多少个成果。侧栏用它来标记「这个对话里有东西」，否则
 * 有成果的对话会被 Show more 折起来，用户看上去就像成果丢了。
 *
 * 两种 id 写法都记一份：接口返回的是 `web:s_xxx`，侧栏树里可能是 `s_xxx`。
 */
export function artifactCounts(data: unknown): Map<string, number> {
  const counts = new Map<string, number>();
  const projects = data && typeof data === 'object' && 'projects' in data && Array.isArray(data.projects)
    ? data.projects as WorkspaceProject[] : [];
  for (const project of projects) {
    if (!project || !Array.isArray(project.sessions)) continue;
    for (const session of project.sessions) {
      const id = session?.id;
      if (typeof id !== 'string' || !id) continue;
      const total = Array.isArray(session.artifacts) ? session.artifacts.length : 0;
      counts.set(id, total);
      counts.set(bareSessionId(id), total);
    }
  }
  return counts;
}

/** 认会话时两种写法都试，和 loadSessionArtifacts 的宽松程度保持一致。 */
export function artifactCountFor(counts: Map<string, number>, sessionId: string): number {
  return counts.get(sessionId) ?? counts.get(bareSessionId(sessionId)) ?? 0;
}

// 侧栏和成果台都要这份数据，模块级缓存让第二次渲染不再发请求。
let artifactCountsPromise: Promise<Map<string, number>> | null = null;

/** 拿到会话 → 成果数。失败时回落到空表：没有标记只是少个徽标，不该拖垮侧栏。 */
export function loadArtifactCounts(force = false): Promise<Map<string, number>> {
  if (force || !artifactCountsPromise) {
    artifactCountsPromise = fetch('/api/artifacts/workspace')
      .then(response => (response.ok ? response.json() : null))
      .then(data => artifactCounts(data))
      .catch(() => new Map<string, number>());
  }
  return artifactCountsPromise;
}

/** 发布新成果后要马上反映到侧栏，否则新出现的对话还是「没有成果」的样子。 */
export function resetArtifactCounts(): void {
  artifactCountsPromise = null;
}
