// 成果台的就地编辑只走 /api/artifacts/{id}/text 这一对接口：拿成果台副本的正文，
// 把改好的正文写回副本。原项目文件在这里永远不会被写到 —— 评审改的是
// 「审这一版」，真要落到项目里走的是「应用 AI 修改」，由 agent 去改。
//
// 服务端把改动记在 meta.edited/edited_at/edited_delta 上，并给一份 unified diff，
// 前端只把它显示出来；版本链不收这里的改动，别指望它出现在「改动」那一页里。

/** 副本与发布时原件的差异：人在成果台上手工改了多少。 */
export type ArtifactTextDelta = {
  edited: boolean;
  added: number;
  removed: number;
  diff?: string;
  truncated?: boolean;
};

export type ArtifactText = {
  artifactId: string;
  text: string;
  bytes: number;
  delta: ArtifactTextDelta;
};

export type ArtifactTextSave = {
  artifactId: string;
  bytes: number;
  delta: ArtifactTextDelta;
};

/**
 * 状态码 → 人话。
 *
 * 服务端多数时候会带一句 error，但有些情况它自己也不知道该怎么解释
 * （404 既可能是没落盘也可能是被清理了），这里补一句更贴近用户处境的说法。
 * 注意 400 不能在这里硬编：空正文和参数缺失都是 400，编死了会把「内容是空的」
 * 说成「参数错了」，所以 400 不预置。
 *
 * 415 一条要同时盖住两种情况：类型不在可编辑清单里，以及文件本身已经超过 2MB
 * —— 后端 editable_reason 把这两件事归成同一个结果（它问的是「这份文件能不能
 * 改」），所以前端也不拆。413 只出现在保存时正文太长这一条路上。
 */
const STATUS_HINTS: Record<number, string> = {
  404: '这份成果没有可编辑的源文件（可能只有图纸，或者已经被清理过）',
  413: '正文超过 2MB，成果台不代劳这么长的文档',
  415: '这个格式（或这份文件的体积）不在成果台可编辑的范围里',
};

function readDelta(value: unknown): ArtifactTextDelta {
  const raw = (value && typeof value === 'object' ? value : {}) as Partial<ArtifactTextDelta>;
  return {
    edited: Boolean(raw.edited),
    added: Number(raw.added) || 0,
    removed: Number(raw.removed) || 0,
    diff: typeof raw.diff === 'string' ? raw.diff : '',
    truncated: Boolean(raw.truncated),
  };
}

/** 失败时把原因翻成人话：错误多半是「不是文本」或「太大了」，光一个 415 用户接不住。 */
async function textError(response: Response, what: string): Promise<Error> {
  let detail = '';
  try {
    const body = await response.json() as { error?: unknown };
    detail = typeof body?.error === 'string' ? body.error : '';
  } catch {
    // 非 JSON 的错误体（比如中间有代理插了一页 HTML）没有可读的理由，
    // 与其把整页塞进提示里，不如退回状态码。
    detail = '';
  }
  return new Error(`${what}：${detail || STATUS_HINTS[response.status] || `HTTP ${response.status}`}`);
}

export async function fetchArtifactText(artifactId: string, signal?: AbortSignal): Promise<ArtifactText> {
  const response = await fetch(
    `/api/artifacts/${encodeURIComponent(artifactId)}/text`,
    signal ? { signal } : undefined,
  );
  if (!response.ok) throw await textError(response, '正文读取失败');
  const data = await response.json() as { text?: unknown; bytes?: unknown; changed?: unknown };
  return {
    artifactId,
    // text 必须是字符串：接口出意外时宁可给空串让用户看见「没有正文」，
    // 也别把 undefined 交给编辑器，那会在保存时变成字符串 "undefined"。
    text: typeof data?.text === 'string' ? data.text : '',
    bytes: Number(data?.bytes) || 0,
    delta: readDelta(data?.changed),
  };
}

export async function saveArtifactText(artifactId: string, text: string): Promise<ArtifactTextSave> {
  const response = await fetch(`/api/artifacts/${encodeURIComponent(artifactId)}/text`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  if (!response.ok) throw await textError(response, '保存失败');
  const data = await response.json() as { bytes?: unknown; changed?: unknown };
  return { artifactId, bytes: Number(data?.bytes) || 0, delta: readDelta(data?.changed) };
}

/** 差异摘要，给保存后的提示用：改动很大时说个「+120 / −18」比贴一整段 diff 有用。 */
export function describeDelta(delta: ArtifactTextDelta): string {
  if (!delta.edited) return '';
  return `已改 +${delta.added} / −${delta.removed} 行`;
}
