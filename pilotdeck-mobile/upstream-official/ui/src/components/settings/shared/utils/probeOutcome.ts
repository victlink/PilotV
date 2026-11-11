import { extractAgentStatusFromBody, formatAgentStatusForDisplay } from '../../../../utils/api';

/**
 * 「测试连接」这类探测请求的结果摘要。
 *
 * - ok：后端是否明确表示成功（body.ok）。
 * - latencyMs：成功时的耗时（毫秒）。缺失时为 NaN，与既有显示语义保持一致。
 * - error：可读的失败原因。无法识别时为 null，由调用方使用本地化兜底文案。
 */
export type ProbeOutcome = {
  ok: boolean;
  latencyMs: number;
  error: string | null;
};

/**
 * 从失败响应里取出可读原因。
 *
 * 只接受三种来源：agent_status 信封、字符串 error、error 对象里的字符串 message。
 * 完整对象、JSON、HTML 和响应配置都不进界面，避免把密钥之类的字段渲染出去。
 */
const readErrorText = (body: unknown): string | null => {
  if (!body || typeof body !== 'object') return null;
  // 网关返回的 agent_status 信封复用统一的提取与展示逻辑。
  // 信封没有可读 message 时不采用格式化里的占位文案（固定英文），继续看普通 error 字段。
  const status = extractAgentStatusFromBody(body);
  const detail = (status?.detail ?? {}) as { message?: unknown };
  if (typeof detail.message === 'string' && detail.message.trim()) {
    const displayed = formatAgentStatusForDisplay(status).trim();
    if (displayed) return displayed;
  }
  const error = (body as { error?: unknown }).error;
  if (typeof error === 'string') {
    const trimmed = error.trim();
    return trimmed || null;
  }
  // 后端把失败原因放在对象里（例如 { code, message }）时只取 message。
  if (error && typeof error === 'object') {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string' && message.trim()) return message.trim();
  }
  return null;
};

/**
 * 读取探测响应。非 JSON 响应（HTML 兜底页等）按无法识别处理，交给调用方兜底文案。
 */
export async function readProbeOutcome(response: Response): Promise<ProbeOutcome> {
  let body: unknown = null;
  try { body = await response.json(); } catch { body = null; }
  const payload = body && typeof body === 'object' ? body as { ok?: unknown; latencyMs?: unknown } : null;
  return {
    ok: Boolean(payload?.ok),
    latencyMs: Number(payload?.latencyMs),
    error: readErrorText(body),
  };
}
