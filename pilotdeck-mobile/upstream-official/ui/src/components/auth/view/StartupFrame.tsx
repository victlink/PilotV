import type { CSSProperties, ReactNode } from 'react';
import { startupStyle } from '../../../../../apps/desktop/src/startupStyle';
import PilotVLogo from '../../app-shell/PilotVLogo';

export default function StartupFrame({ children, error = false, complete = false, leaving = false }: { children: ReactNode; error?: boolean; complete?: boolean; leaving?: boolean }) {
  const elapsed = Date.now() - (window.__pilotdeckStartupState?.startedAt || Date.now() - 1000);
  return <div className="pd-startup-screen" data-error={error} data-complete={complete} data-leaving={leaving} style={{
    '--startup-bg': 'hsl(var(--background))', '--startup-fg': 'hsl(var(--foreground))', '--startup-line': 'hsl(var(--border))', '--startup-muted': 'hsl(var(--muted-foreground))', animationDelay: `-${elapsed}ms`,
  } as CSSProperties}>
    <style>{startupStyle}</style>
    <main>
      {/* 与登录页、侧栏、桌面启动页共用同一个橙 V 字标，不再出现旧字样的纯文本标题。 */}
      <h1 className="pd-startup-brand" aria-label="PilotV"><PilotVLogo height={34} animated={false} /></h1>
      {children}
    </main>
  </div>;
}
