import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, ShieldCheck } from 'lucide-react';
import { authenticatedFetch } from '../../../../../../utils/api';
import { useGatewayStatus } from '../hooks/useGatewayStatus';
import {
  supportedApprovalChannel,
  type ApprovalChannelBinding,
} from '../../../../../../components/approval-session/approvalSession';

const CHANNEL_OPTIONS = [
  { key: 'feishu', label: '飞书', hint: '扫码授权飞书应用后即可使用' },
  { key: 'wecom', label: '企业微信', hint: '扫码接入企业微信机器人后即可使用' },
] as const;

/**
 * 独立审批通道：从消息渠道里选一个已配置好的通道来收审批请求。
 *
 * 原来它是设置侧栏里一个独立页面，用户很难把它和「消息渠道」联系起来；
 * 现在并入设置 → 消息渠道，配置与选择在同一页完成。服务端会从当前账号
 * 补齐会话与审批人，不需要手填 ID（高级设置里仍可显式指定）。
 */
export default function ApprovalChannelSection() {
  const { t } = useTranslation('settings');
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
    <section className="integration-section" aria-labelledby="approval-channel-title">
      <div className="general-card integration-channels-card">
        <header className="general-card-header integration-channels-header">
          <span className="general-card-header-icon" aria-hidden="true"><ShieldCheck size={18} /></span>
          <div>
            <h2 id="approval-channel-title">{t('settingsPage.menu.approvalChannel')}</h2>
            <p>{t('gateway.approvalHint')}</p>
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
            <p className="mt-2 text-amber-600 dark:text-amber-400">当前所选渠道尚未配置，请先在上方扫码接入。</p>
          ) : null}
          <p className="mt-2 text-xs text-muted-foreground">{CHANNEL_OPTIONS.find(c => c.key === binding.channelKey)?.hint}；微信渠道暂未接入审批。</p>

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
  );
}
