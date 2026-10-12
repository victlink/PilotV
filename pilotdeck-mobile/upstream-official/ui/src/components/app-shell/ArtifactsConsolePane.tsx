import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { listSessionArtifacts, type Artifact } from './artifactsMedia';
import { appendToComposer, buildComposerText, loadOpenNotes } from './artifactFeedback';

// Only the review stage belongs in this app: the console keeps its own tree and
// chrome, so drop them and drive selection from here instead.
const CONSOLE_CHROME_CSS = `
  .art-topbar, .art-side, .art-sheet, .art-back { display: none !important; }
  .art-body { grid-template-columns: minmax(0, 1fr) var(--anno-w, 360px) !important; }
  .art-main { min-width: 0; }
  /* 手机／竖屏平板：同样的两栏会把舞台压成 36px 的竖条，
     这里跟着成果台的窄屏排布改成上下两段。 */
  @media (max-width: 860px) {
    .art-body {
      grid-template-columns: minmax(0, 1fr) !important;
      grid-template-rows: minmax(0, 1fr) minmax(140px, 40vh) !important;
    }
    .art-body > .art-stage { grid-column: 1 !important; grid-row: 1 !important; }
    .art-body > .art-anno { grid-column: 1 !important; grid-row: 2 !important; }
  }
`;

function SessionArtifacts({ sessionId }: { sessionId: string }) {
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [index, setIndex] = useState(0);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);
  const consoleFrame = useRef<HTMLIFrameElement | null>(null);
  const [revealed, setRevealed] = useState(false);
  const revealedFor = useRef<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setArtifacts([]);
    setIndex(0);
    setStatus('loading');
    setError('');
    void listSessionArtifacts(sessionId, controller.signal).then(items => {
      if (controller.signal.aborted) return;
      setArtifacts(items);
      setStatus('ready');
    }).catch(cause => {
      if (controller.signal.aborted) return;
      setStatus('error');
      setError(cause instanceof Error ? cause.message : '成果列表请求失败');
    });
    return () => controller.abort();
  }, [sessionId, refresh]);

  const selected = artifacts[index];
  // The console keeps its own tree and selects on click; poll briefly after load so a
  // slow list render still finds the entry instead of giving up on the first miss.
  const revealSelection = useCallback(() => {
    const target = selected?.id;
    if (!target) return;
    // Only reset when the target actually changes, so a console reload does not
    // flash the pending hint over content that is already on screen.
    if (revealedFor.current !== target) {
      revealedFor.current = target;
      setRevealed(false);
    }
    let attempts = 0;
    const timer = window.setInterval(() => {
      attempts += 1;
      const doc = consoleFrame.current?.contentDocument;
      const node = doc?.querySelector(`[data-id="${CSS.escape(target)}"]`);
      // Elements from the embedded console belong to its own realm, so instanceof
      // against this window's HTMLElement is always false; check the DOM capability.
      if (node && typeof (node as Element).click === 'function') {
        (node as Element).scrollIntoView({ block: 'center' });
        (node as Element).click();
        window.clearInterval(timer);
        setRevealed(true);
      } else if (attempts > 160) {
        window.clearInterval(timer);
      }
    }, 250);
    return () => window.clearInterval(timer);
  }, [selected?.id]);

  useEffect(() => revealSelection(), [revealSelection, refresh]);
  // The console refreshes its own list over SSE, so keep looking until it settles.
  useEffect(() => {
    if (revealed || !selected) return;
    const timer = window.setInterval(() => revealSelection(), 4000);
    return () => window.clearInterval(timer);
  }, [revealed, selected, revealSelection]);
  const move = (direction: number) => setIndex(current => Math.min(artifacts.length - 1, Math.max(0, current + direction)));
  const touchX = useRef<number | null>(null);
  const syncedNotes = useRef<Set<string>>(new Set());
  const [syncState, setSyncState] = useState('');

  // Push new reviewer notes into this conversation's composer so a rework request
  // never has to be retyped. Notes already synced are remembered per artifact.
  useEffect(() => {
    if (!selected?.id) return;
    const controller = new AbortController();
    let cancelled = false;
    const pull = async () => {
      try {
        const notes = await loadOpenNotes(selected.id, controller.signal);
        if (cancelled || !notes.length) return;
        const fresh = notes.filter(note => !syncedNotes.current.has(note.id));
        if (!fresh.length) return;
        const title = selected.title || selected.file_name || selected.id;
        if (!appendToComposer(buildComposerText(title, fresh))) {
          setSyncState('未找到对话输入框，标注未同步');
          return;
        }
        fresh.forEach(note => syncedNotes.current.add(note.id));
        setSyncState(`已把 ${fresh.length} 条标注同步到对话输入`);
      } catch {
        // The pane stays usable without the sync; the console still owns the notes.
      }
    };
    void pull();
    const timer = window.setInterval(() => void pull(), 6000);
    return () => { cancelled = true; controller.abort(); window.clearInterval(timer); };
  }, [selected?.id, selected?.title, selected?.file_name]);

  return <section aria-label="当前会话成果" className="flex h-full min-h-0 flex-col" onKeyDown={event => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey ||
        (event.target instanceof Element && event.target.closest('input, textarea, select, [contenteditable="true"]'))) return;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      move(event.key === 'ArrowLeft' ? -1 : 1);
    }
  }}>
    {/* Artifact picker lives in the app header on desktop, where the row has room.
        On phones the header already carries 对话/成果 + title + search, and a second
        control cluster there overlaps them — so on mobile it renders as its own row
        on top of the stage instead. */}
    {(() => {
      const controls = <div className="flex min-w-0 flex-wrap items-center gap-1 text-xs">
        <label className="min-w-0 flex-1 text-xs"><span className="sr-only">当前会话成果</span>
          <select aria-label="选择成果" className="max-w-full rounded border border-border bg-background p-2" value={selected?.id || ''} disabled={status !== 'ready' || !artifacts.length} onChange={event => setIndex(artifacts.findIndex(item => item.id === event.target.value))}>
            {!selected && <option value="">暂无成果</option>}
            {artifacts.map((item, position) => <option key={`${item.id}-${position}`} value={item.id}>{position + 1}. {item.title || item.file_name || item.id}</option>)}
          </select>
        </label>
        <button type="button" className="min-h-11 rounded border border-border px-3" disabled={status !== 'ready' || index <= 0} onClick={() => move(-1)}>上一个</button>
        <span className="text-sm" aria-live="polite">{artifacts.length ? `${index + 1} / ${artifacts.length}` : '0 / 0'}</span>
        <button type="button" className="min-h-11 rounded border border-border px-3" disabled={status !== 'ready' || index >= artifacts.length - 1} onClick={() => move(1)}>下一个</button>
        <button type="button" className="min-h-11 rounded border border-border px-3" onClick={() => setRefresh(value => value + 1)}>刷新</button>
      </div>;

      if (typeof window !== 'undefined' && window.matchMedia('(max-width: 1024px)').matches) {
        return <div className="shrink-0 border-b border-border px-2 py-2">{controls}</div>;
      }
      const slot = document.getElementById('artifacts-header-controls');
      return slot ? createPortal(controls, slot) : null;
    })()}
    <div aria-label="滑动切换成果" className="shrink-0 select-none border-b border-border px-3 py-2 text-xs text-muted-foreground" onTouchStart={event => { touchX.current = event.touches[0]?.clientX ?? null; }} onTouchEnd={event => {
      const end = event.changedTouches[0]?.clientX;
      if (touchX.current !== null && end !== undefined && Math.abs(end - touchX.current) > 40 && status === 'ready') move(end < touchX.current ? 1 : -1);
      touchX.current = null;
    }}>在此滑动切换成果（嵌入内容内的手势不生效）</div>
    {status === 'loading' && <p role="status" className="p-4">正在加载当前会话成果…</p>}
    {status === 'error' && <p role="alert" className="p-4">{error}。请检查成果 API 是否可用后刷新。</p>}
    {status === 'ready' && !selected && <p className="p-4 text-sm text-muted-foreground">当前会话暂无成果。</p>}
    {selected && <div className="flex min-h-0 flex-1 flex-col">
      {/* Rendering, 3D/CAD/drawing support and annotation all come from the merged
          console, so this app never re-implements a viewer. The console selects an
          artifact by clicking its own tree entry, so drive that instead of guessing a
          deep link the console does not implement. */}
      <iframe
        ref={consoleFrame}
        src="/artifacts.html"
        title="成果台"
        onLoad={event => {
          const doc = event.currentTarget.contentDocument;
          if (!doc) return;
          const style = doc.createElement('style');
          style.textContent = CONSOLE_CHROME_CSS;
          doc.head.append(style);
          revealSelection();
        }}
        className="min-h-0 w-full flex-1 border-0"
      />
      {!revealed && <p role="status" className="shrink-0 px-3 py-1 text-xs text-muted-foreground">正在定位成果…若长时间无反应，请
        <a href="/artifacts.html" target="_blank" rel="noopener noreferrer" className="underline">在新窗口打开成果台</a>。</p>}
      {syncState && <p role="status" className="shrink-0 px-3 py-1 text-xs text-muted-foreground">{syncState}</p>}
    </div>}
  </section>;
}

export default function ArtifactsConsolePane({ sessionId }: { sessionId?: string }) {
  // Keying the subtree drops both selection and data before a new session's first render.
  if (!sessionId) return <section aria-label="当前会话成果" className="p-4 text-sm">请先选择会话。</section>;
  return <SessionArtifacts key={sessionId} sessionId={sessionId} />;
}
