// Session artifacts come from the console's workspace endpoint, which attributes each
// artifact to exactly one session. The server scopes the response with ?session=;
// this file only confirms the session it got back is the one it asked for.
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

export type MediaType = 'image' | 'audio' | 'video' | 'iframe' | 'markdown' | 'model3d' | 'drawing' | 'unsupported';

export function mediaType(artifact: Artifact): MediaType {
  const mime = (artifact.mime || '').split(';', 1)[0].trim().toLowerCase();
  const ext = artifactExt(artifact);
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
  // markdown 单独一类：它和 txt/json 一样是 text/*，可浏览器根本不渲染
  // text/markdown，塞进 iframe 出来的是一堆 `#` 和 `**`。成果台里最常翻的
  // 恰恰是 README / 报告，所以它得有自己的渲染路，而不是跟着纯文本一起当源码。
  if (mime === 'text/markdown' || ext === '.md' || ext === '.markdown') return 'markdown';
  if (mime.startsWith('text/') || ['.txt', '.csv', '.json', '.log'].includes(ext)) return 'iframe';
  return 'unsupported';
}

/** 类型下拉里的固定顺序：先看图，再看文，最后才是兜底的「其他」。 */
const TYPE_ORDER: readonly MediaType[] = ['image', 'drawing', 'markdown', 'iframe', 'video', 'audio', 'model3d', 'unsupported'];

const TYPE_LABELS: Record<MediaType, string> = {
  image: '图片',
  drawing: '手绘',
  markdown: 'Markdown',
  iframe: '网页 / 文档',
  video: '视频',
  audio: '音频',
  model3d: '三维模型',
  unsupported: '其他',
};

/**
 * 成果台里能就地改的文本类型。
 *
 * 必须和 artifacts_deliver.EDITABLE_EXT 对齐：多一个，页面会给出一个后端
 * 必然回 415 的「编辑」入口；少一个，后端明明能改的文档在前端却看不出来能改。
 * 两份清单各改一处就会漂，所以后端那份才是唯一事实来源。
 */
const EDITABLE_DOC_EXT = ['.html', '.htm', '.md', '.markdown', '.txt', '.svg', '.json',
  '.css', '.js', '.jsx', '.ts', '.vue', '.yaml', '.yml'];

/**
 * 这份成果要不要给「编辑」入口。
 *
 * 只认按文档显示的类型：图片／视频／三维本来就不是正文，给个编辑器只会让人
 * 以为这些格式也能改文本。SVG 虽然是文本，成果台按图显示它，编辑入口也就不摆。
 * 体积上限（2MB）不在这里判断：磁盘上已经超大的那份后端回 415（editable_reason
 * 管的是「这份文件能不能改」），保存时正文太长才回 413，两条都带现成的人话。
 * 在这里先猜一遍只会更早拒绝一份其实能存的文档。
 */
export function isEditableDocument(artifact: Artifact): boolean {
  const type = mediaType(artifact);
  return (type === 'markdown' || type === 'iframe') && EDITABLE_DOC_EXT.includes(artifactExt(artifact));
}

export function artifactTypeLabel(type: MediaType): string {
  return TYPE_LABELS[type] || type;
}

/**
 * 一批成果里各有几份、分别是什么类型，顺序固定、带数量。
 *
 * 判定只认 mediaType：它已经按 mime + 扩展名兜过一遍（kind 与后缀对不上时，
 * 复杂格式优先），所以这里不另写一套映射，免得两份规则越改越不一样。
 */
export function artifactTypeFacets(items: readonly Artifact[]): { value: MediaType; label: string; count: number }[] {
  const counts = new Map<MediaType, number>();
  for (const item of items) {
    const type = mediaType(item);
    counts.set(type, (counts.get(type) || 0) + 1);
  }
  return TYPE_ORDER
    .filter(type => counts.has(type))
    .map(type => ({ value: type, label: artifactTypeLabel(type), count: counts.get(type) as number }));
}

type WorkspaceProject = { id?: string | null; sessions?: WorkspaceSession[] | null };
type WorkspaceSession = { id?: string | null; artifacts?: Artifact[] | null };

/**
 * 取某个会话的成果。
 *
 * 过滤在服务端做（?session=），不是拉整棵树回来再在浏览器里挑。原来是
 * `/api/artifacts/workspace` 一次回全部项目全部会话，成果台面板再按 id 挑一遍：
 * 别的会话的成果真的发到了浏览器（会话隔离的最后一环就在这儿），而且默认
 * limit=400 一截断，成果偏老的那个会话就会凭空显示成空。
 *
 * 仍然保留一次 id 比对作为兜底：万一服务端把 session 参数丢了（比如中间有代理
 * 改了 query），这里还能认出自己那个会话，而不是安静地返回空列表。
 */
export async function loadSessionArtifacts(sessionId: string, signal: AbortSignal): Promise<Artifact[]> {
  const query = `?session=${encodeURIComponent(sessionId)}`;
  const response = await fetch(`/api/artifacts/workspace${query}`, { signal });
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
