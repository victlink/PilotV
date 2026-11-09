import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Check, QrCode, ShieldCheck } from 'lucide-react';
import { authenticatedFetch } from '../../utils/api';
import { getSettingsPath } from '../settings/navigation';
import { useGatewayStatus } from '../settings/view/integrations/im/hooks/useGatewayStatus';
import { supportedApprovalChannel, type ApprovalChannelBinding } from './approvalSession';

const CHANNEL_OPTIONS = [
  { key: 'feishu', label: '飞书', hint: '扫码授权飞书应用后即可使用' },
  { key: 'wecom', label: '企业微信', hint: '扫码接入企业微信机器人后即可使用' },
] as const;

/**
 * Bind the dedicated approval session to an already configured IM channel.
 *
 * The channel itself is set up by scanning a QR code in Settings → Message
 * Channels. This page only picks one of those channels: the server fills in the
 * chat and approver identity from the current account, so the old manual
 * "chat ID / approver ID" form is no longer required (it stays available under
 * Advanced for operators who need an explicit binding).
 */
export default function ApprovalChannelSettings() {
  const navigate = useNavigate();
  const { status, loading, refresh } = useGatewayStatus();
  const [binding, setBinding] = useState<ApprovalChannelBinding>({ enabled: false, channelKey: 'feishu', chatId: '', approverIds: [] });
  const [message, setMessage] = useState('');

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
    }).catch(error => setMessage(error instanceof Error ? error.message : '无法读取审批通道配置'));
  }, []);

  const configured = (key: string) => key === 'feishu'
    ? status?.feishu?.enabled === true
    : key === 'wecom'
      ? status?.wecom?.enabled === true
      : false;
  const selectedConfigured = configured(binding.channelKey);

  const save = async () => {
    setMessage('保存中…');
    try {
      // Omit both IDs when the advanced fields are empty: the server fills the
      // approver allow-list from the authenticated account and lets the
      // channel use its default chat. Explicit values still win.
      const payload: Record<string, unknown> = { enabled: binding.enabled, channelKey: binding.channelKey };
      if (binding.chatId.trim()) payload.chatId = binding.chatId.trim();
      if (binding.approverIds.length) payload.approverIds = binding.approverIds;
      const res = await authenticatedFetch('/api/approval-session/channel', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const detail = await res.json().catch(() => null) as { error?: string } | null;
        throw new Error(detail?.error || `保存失败（${res.status}）`);
      }
      const result = (await res.json().catch(() => null)) as { session?: { channelBinding?: ApprovalChannelBinding } } | null;
      const saved = result?.session?.channelBinding;
      if (saved) setBinding({ enabled: Boolean(saved.enabled), channelKey: saved.channelKey || 'feishu', chatId: saved.chatId || '', approverIds: Array.isArray(saved.approverIds) ? saved.approverIds : [] });
      void refresh();
      setMessage('已保存');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '保存失败');
    }
  };

  return (
    <div className="approval-channel-page">
      <section className="security-section" aria-labelledby="approval-channel-title">
        <div className="security-card">
          <header className="security-card-header">
            <span className="security-card-header-icon" aria-hidden="true">
              <ShieldCheck size={19} />
            </span>
            <div>
              <h2 id="approval-channel-title">独立审批通道</h2>
              <p>选择一个已经配置好的消息渠道即可。审批请求会推送到该渠道，会话与审批人由服务端自动使用当前账号和渠道默认配置，无需手动填写 ID。</p>
            </div>
          </header>
          <div className="approval-channel-body p-5 text-sm">
      <label className="flex items-center gap-2">
        <input type="checkbox" checked={binding.enabled} onChange={e => setBinding({ ...binding, enabled: e.target.checked })} />
        启用独立审批通道
      </label>

      <h3 className="mt-5 font-medium">选择消息渠道</h3>
      {loading ? (
        <p className="mt-2 text-muted-foreground">正在读取渠道配置…</p>
      ) : (
        <div className="mt-2 grid gap-2 sm:grid-cols-2">
          {CHANNEL_OPTIONS.map(channel => {
            const ready = configured(channel.key);
            const selected = binding.channelKey === channel.key;
            return (
              <button
                key={channel.key}
                type="button"
                disabled={!binding.enabled || !ready}
                onClick={() => setBinding({ ...binding, channelKey: channel.key })}
                className={`flex items-start gap-2 rounded-lg border p-3 text-left transition disabled:cursor-not-allowed disabled:opacity-50 ${selected ? 'border-primary bg-primary/5' : 'hover:bg-accent'}`}
              >
                <span className="mt-0.5 font-medium">{channel.label}</span>
                <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                  {ready ? '已配置' : '未配置'}
                </span>
                {selected && ready ? <Check className="h-4 w-4 shrink-0 text-primary" aria-hidden /> : null}
              </button>
            );
          })}
        </div>
      )}
      {binding.enabled && !loading && !selectedConfigured ? (
        <p className="mt-2 text-amber-600 dark:text-amber-400">当前所选渠道尚未配置，请先扫码接入。</p>
      ) : null}
      <p className="mt-2 text-xs text-muted-foreground">{CHANNEL_OPTIONS.find(c => c.key === binding.channelKey)?.hint}；微信渠道暂未接入审批。</p>

      <button type="button" onClick={() => navigate(getSettingsPath('integrations'))}
        className="mt-3 inline-flex items-center gap-1.5 rounded-md border px-3 py-2 text-xs font-medium hover:bg-accent">
        <QrCode className="h-3.5 w-3.5" aria-hidden />扫码配置 / 管理消息渠道
      </button>

      <details className="mt-5 rounded-lg border p-3">
        <summary className="cursor-pointer font-medium">高级设置（可选）</summary>
        <p className="mt-2 text-xs text-muted-foreground">留空即可：服务端会使用渠道默认会话，并把当前登录账号作为审批人（保持审批白名单不为空）。若要用飞书 / 企业微信的成员身份审批，或推送到指定群，请在这里填写对应 ID。</p>
        <label className="mt-3 block">
          会话 ID
          <input className="mt-1 block w-full rounded-md border bg-background p-2" value={binding.chatId}
            onChange={e => setBinding({ ...binding, chatId: e.target.value })} placeholder="留空使用渠道默认会话" />
        </label>
        <label className="mt-3 block">
          审批人 ID（每行一个）
          <textarea className="mt-1 block w-full rounded-md border bg-background p-2" rows={3}
            value={binding.approverIds.join('\n')}
            onChange={e => setBinding({ ...binding, approverIds: e.target.value.split(/\n|,/).map(id => id.trim()).filter(Boolean) })}
            placeholder="留空使用当前登录账号" />
        </label>
      </details>

      <div className="mt-5 flex items-center gap-3">
        <button disabled={!supportedApprovalChannel(binding.channelKey) || (binding.enabled && !selectedConfigured)}
          onClick={() => void save()}
          className="rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground disabled:opacity-50">
          保存配置
        </button>
        {message ? <span role="status" className="text-muted-foreground">{message}</span> : null}
      </div>
          </div>
        </div>
      </section>
    </div>
  );
}
