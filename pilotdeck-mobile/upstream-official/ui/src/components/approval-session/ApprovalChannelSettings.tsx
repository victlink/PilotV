import { useEffect, useState } from 'react';
import { authenticatedFetch } from '../../utils/api';
import { supportedApprovalChannel, type ApprovalChannelBinding } from './approvalSession';

export default function ApprovalChannelSettings() {
  const [binding, setBinding] = useState<ApprovalChannelBinding>({ enabled: false, channelKey: 'feishu', chatId: '', approverIds: [] });
  const [status, setStatus] = useState('');
  useEffect(() => {
    void authenticatedFetch('/api/approval-session').then(async response => {
      if (!response.ok) throw new Error(`读取失败（${response.status}）`);
      const payload: unknown = await response.json();
      if (!payload || typeof payload !== 'object') throw new Error('读取失败（响应格式错误）');
      const session = (payload as { session?: unknown }).session;
      const channelBinding = session && typeof session === 'object' ? (session as { channelBinding?: unknown }).channelBinding : undefined;
      if (!channelBinding || typeof channelBinding !== 'object') throw new Error('读取失败（缺少通道配置）');
      const value = channelBinding as Partial<ApprovalChannelBinding>;
      setBinding({ enabled: Boolean(value.enabled), channelKey: typeof value.channelKey === 'string' ? value.channelKey : 'feishu', chatId: typeof value.chatId === 'string' ? value.chatId : '', approverIds: Array.isArray(value.approverIds) ? value.approverIds.filter((id): id is string => typeof id === 'string') : [] });
    }).catch(error => setStatus(error instanceof Error ? error.message : '无法读取审批通道配置'));
  }, []);
  const save = async () => { setStatus('保存中…'); try { const res = await authenticatedFetch('/api/approval-session/channel', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(binding) }); if (!res.ok) throw new Error(`保存失败（${res.status}）`); setStatus('已保存'); } catch (error) { setStatus(error instanceof Error ? error.message : '保存失败'); } };
  return <section className="rounded-xl border bg-card p-4"><h2 className="font-semibold">独立审批通道</h2><p className="mt-1 text-sm text-muted-foreground">仅支持飞书与企业微信绑定；微信等渠道尚未接入。</p><label className="mt-4 flex items-center gap-2 text-sm"><input type="checkbox" checked={binding.enabled} onChange={e => setBinding({ ...binding, enabled: e.target.checked })} />启用独立审批通道</label><label className="mt-3 block text-sm">渠道<select className="mt-1 block w-full rounded-md border bg-background p-2" value={binding.channelKey} onChange={e => setBinding({ ...binding, channelKey: e.target.value })}><option value="feishu">飞书</option><option value="wecom">企业微信</option><option value="weixin" disabled>微信（未接入）</option></select></label><label className="mt-3 block text-sm">会话 ID<input className="mt-1 block w-full rounded-md border bg-background p-2" value={binding.chatId} onChange={e => setBinding({ ...binding, chatId: e.target.value })} /></label><label className="mt-3 block text-sm">审批人 ID（每行一个）<textarea className="mt-1 block w-full rounded-md border bg-background p-2" rows={3} value={binding.approverIds.join('\n')} onChange={e => setBinding({ ...binding, approverIds: e.target.value.split(/\n|,/).map(id => id.trim()).filter(Boolean) })} /></label><button disabled={!supportedApprovalChannel(binding.channelKey)} onClick={() => void save()} className="mt-4 rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground disabled:opacity-50">保存配置</button>{status && <span role="status" className="ml-3 text-sm text-muted-foreground">{status}</span>}</section>;
}
