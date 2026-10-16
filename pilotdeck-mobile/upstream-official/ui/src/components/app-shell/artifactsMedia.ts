// Session artifacts come from the console's workspace endpoint: it attributes each
// artifact to a session the way the reviewer sees it (publish-time run id plus the
// project directory its source file lives in). Matching on run_id alone dropped
// everything attributed by path, which is why a session could look empty.
export function ownsSession(runId: unknown, sessionId: string): boolean {
  if (typeof runId !== 'string' || !sessionId) return false;
  if (runId === sessionId) return true;
  // Only relax an unqualified side; two explicit channels are distinct owners.
  if (runId.includes(':') && sessionId.includes(':')) return false;
  return runId.split(':').pop() === sessionId.split(':').pop();
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
  // ts / agent / entry.meta are what the「只留每轮最终结果」过滤要用的事实：
  // 什么时候发的、谁发的、有没有声明自己是多结果对比。
  ts?: string | null;
  agent?: string | null;
  version?: number | null;
  parent_id?: string | null;
  entry?: { url?: string | null; thumb_url?: string | null; meta?: Record<string, unknown> | null } | null;
  open_notes?: number | null;
};

/**
 * model-viewer 只认 glTF，别的三维格式喂进去是一块空白。成果台在 /viewer 上
 * 现转成 glb（转不了时接口会明说原因），这里只管「哪些要走转换口」。
 */
const CONVERTIBLE_EXT = ['.step', '.stp', '.iges', '.igs', '.stl', '.obj', '.ply'];
/** 本机没有转换器的三维格式：模型区得先说清楚，不能只留一块灰。 */
const UNCONVERTIBLE_3D_EXT = ['.3ds', '.dae', '.3mf', '.blend'];

function artifactExt(artifact: Artifact): string {
  return (artifact.file_name || artifact.source_path || '').split(/[?#]/, 1)[0]
    .toLowerCase().match(/\.[^.\/]+$/)?.[0] || '';
}

export function isCadArtifact(artifact: Artifact): boolean {
  return CONVERTIBLE_EXT.includes(artifactExt(artifact));
}

/** 喂给三维渲染器的地址：要转换的走 /viewer，其余就是成果台存下来的原文件。 */
export function artifactViewerUrl(artifact: Artifact): string {
  return isCadArtifact(artifact) ? `/api/artifacts/${encodeURIComponent(artifact.id)}/viewer` : artifactRawUrl(artifact);
}

/** 浏览器渲染不了的模型格式（3ds/dae/3mf/blend）：提示下载原文件。 */
export function isUnconvertible3d(artifact: Artifact): boolean {
  return UNCONVERTIBLE_3D_EXT.includes(artifactExt(artifact));
}

/** 发布时声明的「这几份是对比，要一起看」。没声明就按普通成果收。 */
export function compareGroup(artifact: Artifact): string {
  const value = artifact.entry?.meta?.compare_group;
  return typeof value === 'string' ? value.trim() : '';
}

export type MediaType = 'image' | 'audio' | 'video' | 'iframe' | 'model3d' | 'drawing' | 'unsupported';

export function mediaType(artifact: Artifact): MediaType {
  const mime = (artifact.mime || '').split(';', 1)[0].trim().toLowerCase();
  const ext = (artifact.file_name || artifact.source_path || '').split(/[?#]/, 1)[0].toLowerCase().match(/\.[^.\/]+$/)?.[0] || '';
  // A declared complex format must not be mistaken for a simple image or document.
  // 3ds/dae/3mf/blend 也算三维：渲染不了也要给「下载原文件」这条路，
  // 落到 unsupported 只会让人以为成果台没收到这个文件。
  if (artifact.kind === 'model3d' || ext === '.glb' || ext === '.gltf'
      || CONVERTIBLE_EXT.includes(ext) || UNCONVERTIBLE_3D_EXT.includes(ext)) return 'model3d';
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
