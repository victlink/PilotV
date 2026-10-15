import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ExternalLink, RefreshCw } from 'lucide-react';
import { weknoraBaseUrl } from '../app-shell/pilotvRuntime';

const HEALTH_PATH = '/__pilotv_health';
const PROBE_TIMEOUT_MS = 5000;

type Status = 'probing' | 'ready' | 'down';

/**
 * 「资料」页：整块 iframe 打开本机 WeKnora。
 *
 * iframe 是跨源的（PilotV 在 5186，WeKnora 在 8080），所以拿不到里面的状态，
 * 进页面前先用侧车那个放行 CORS 的探活接口问一句：通了再挂 iframe，不通就把
 * 「WeKnora 没起来」和怎么起说清楚。直接挂 iframe 的话，WeKnora 停了用户只会
 * 在页面里看到浏览器自己的报错页，完全不知道该去看 Docker。
 *
 * 探活通过后就直接交出画面，不再盖「等 iframe load」的转圈层：WeKnora 页面里
 * 有长连接请求时 load 事件会一直拖着不触发，那种情况下用户看到的就是一整块
 * 白屏加一个永远转不出来的圈。
 */
export default function WeKnoraArea() {
  const { t } = useTranslation();
  const base = weknoraBaseUrl();
  const [status, setStatus] = useState<Status>('probing');
  const [attempt, setAttempt] = useState(0);
  const frameRef = useRef<HTMLIFrameElement | null>(null);

  useEffect(() => {
    if (!base) { setStatus('down'); return undefined; }
    let cancelled = false;
    const controller = new AbortController();
    setStatus('probing');

    const timer = window.setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
    fetch(`${base}${HEALTH_PATH}`, { signal: controller.signal, cache: 'no-store' })
      .then(response => { if (!cancelled) setStatus(response.ok ? 'ready' : 'down'); })
      .catch(() => { if (!cancelled) setStatus('down'); })
      .finally(() => window.clearTimeout(timer));

    return () => { cancelled = true; controller.abort(); window.clearTimeout(timer); };
  }, [base, attempt]);

  const reload = useCallback(() => {
    setAttempt(value => value + 1);
    const frame = frameRef.current;
    // 已经是 ready 时探测结果没变化，得靠重设 src 让 iframe 真的重载。
    if (frame) frame.src = frame.src;
  }, []);

  return (
    <div
      data-testid="weknora-area"
      data-state={status}
      className="flex h-full w-full min-h-0 min-w-0 flex-col bg-white text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100"
    >
      <div className="flex h-12 shrink-0 items-center justify-between gap-3 border-b border-neutral-200 px-4 dark:border-neutral-800">
        <h2 className="min-w-0 truncate text-[15px] font-semibold">
          {t('weknora.title', { defaultValue: '资料' }) as string}
        </h2>
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={reload}
            aria-label={t('weknora.reload', { defaultValue: '重新加载' }) as string}
            data-tooltip={t('weknora.reload', { defaultValue: '重新加载' }) as string}
            className="icon-button tooltip tooltip-bottom"
          >
            <RefreshCw aria-hidden="true" className="icon" height="18" strokeWidth={1.8} width="18" />
          </button>
          {base ? (
            <a
              href={base}
              target="_blank"
              rel="noreferrer noopener"
              aria-label={t('weknora.openExternal', { defaultValue: '在新标签打开' }) as string}
              data-tooltip={t('weknora.openExternal', { defaultValue: '在新标签打开' }) as string}
              className="icon-button tooltip tooltip-bottom"
            >
              <ExternalLink aria-hidden="true" className="icon" height="18" strokeWidth={1.8} width="18" />
            </a>
          ) : null}
        </div>
      </div>

      <div className="relative min-h-0 flex-1 overflow-hidden">
        {status === 'ready' ? (
          <iframe
            ref={frameRef}
            title={t('weknora.frameTitle', { defaultValue: 'WeKnora 资料库' }) as string}
            src={`${base}/`}
            className="h-full w-full border-0 bg-white"
          />
        ) : status === 'down' ? (
          <div className="flex h-full w-full flex-col items-center justify-center gap-3 px-6 text-center">
            <p className="text-[15px] font-medium">
              {t('weknora.down', { defaultValue: '连不上本机的 WeKnora' }) as string}
            </p>
            <p className="max-w-md text-[13px] leading-6 text-neutral-500 dark:text-neutral-400">
              {t('weknora.downHint', {
                defaultValue: '资料库服务没在跑。在部署 WeKnora 的机器上执行 docker compose -f docker-compose.yml -f pilotv/docker-compose.pilotv.yml up -d，然后重试。',
              }) as string}
            </p>
            {base ? (
              <p className="font-mono text-[12px] text-neutral-400">{base}</p>
            ) : null}
            <button
              type="button"
              onClick={reload}
              className="mt-1 inline-flex h-8 items-center gap-2 rounded-lg bg-blue-600 px-3 text-[13px] font-medium text-white hover:bg-blue-700"
            >
              <RefreshCw aria-hidden="true" className="h-4 w-4" strokeWidth={1.8} />
              {t('weknora.retry', { defaultValue: '重试' }) as string}
            </button>
          </div>
        ) : (
          <div className="flex h-full w-full items-center justify-center">
            <div className="h-6 w-6 animate-spin rounded-full border-2 border-neutral-300 border-t-neutral-600 dark:border-neutral-600 dark:border-t-neutral-300" />
          </div>
        )}
      </div>
    </div>
  );
}