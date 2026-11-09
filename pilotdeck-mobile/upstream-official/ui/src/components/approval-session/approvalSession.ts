export type ApprovalRisk = 'low' | 'medium' | 'high' | 'critical' | string;
export type ApprovalState = 'pending' | 'expired' | 'cancelled' | 'approved' | 'denied' | 'processed' | string;
export type ApprovalRequest = {
  id: string; requestId: string; sessionId: string; projectName: string; projectKey: string;
  kind: 'permission' | 'elicitation'; toolName?: string; summary: string; input?: unknown; context?: unknown;
  /** Redacted, human readable preview of the concrete request content. */
  payloadPreview?: string; payloadRedacted?: boolean;
  createdAt: string; updatedAt: string; state: ApprovalState; risk?: ApprovalRisk; expiresAt?: string;
};
export type ApprovalChannelBinding = { enabled: boolean; channelKey: string; chatId: string; approverIds: string[] };
export type ApprovalSessionPayload = { session: { id: string; title: string; channelBinding: ApprovalChannelBinding }; requests: ApprovalRequest[] };
export const sortApprovalRequests = (requests: ApprovalRequest[]) => [...requests].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
export const formatBeijingTime = (value: string) => new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
export const supportedApprovalChannel = (key: string) => key === 'feishu' || key === 'wecom';
export const isApprovalInactive = (request: ApprovalRequest, now = Date.now()) => ['expired', 'cancelled', 'approved', 'denied', 'processed'].includes(request.state) || (request.expiresAt ? Date.parse(request.expiresAt) <= now : false);
export const isHighRisk = (risk?: ApprovalRisk) => risk === 'high' || risk === 'critical';
export const originSessionUrl = (request: ApprovalRequest) => {
  if (!request.context || typeof request.context !== 'object') return null;
  const context = request.context as Record<string, unknown>;
  const value = context.originUrl ?? context.sessionUrl;
  return typeof value === 'string' && value.length > 0 ? value : null;
};
