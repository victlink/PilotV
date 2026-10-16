import { useCallback, useEffect, useRef, useState } from 'react';
import { loadSessionArtifacts, type Artifact } from './artifactsMedia';
import { finalArtifacts } from './artifactRounds';
import {
  createAnnotation,
  deleteAnnotation,
  fetchArtifactDetail,
  setAnnotationStatus,
  type Annotation,
} from './artifactAnnotations';
import ArtifactStage, { type Draft } from './ArtifactStage';
import { appendInkToComposer, appendToComposer, attachInkAndSubmit, buildComposerText } from './artifactFeedback';

function notePosition(notes: Annotation[]): number {
  const seqs = notes.map(note => Number(note.seq) || 0);
  return seqs.length ? Math.max(...seqs) + 1 : 1;
}

async function readJson(response: Response, what: string): Promise<any> {
  if (!response.ok) {
    let detail = '';
    try { detail = (await response.json())?.error || ''; } catch { detail = ''; }
    throw new Error(`${what}（HTTP ${response.status}${detail ? `：${detail}` : ''}）`);
  }
  return response.json();
}

/**
 * A session with nothing published still has to be annotatable, so the first
 * stroke creates the sheet it is drawn on. `deliverable: "aux"` is required:
 * api_create runs every incoming artifact through the classifier, which rejects
 * a file-less record as "not an independent final deliverable", and a sketch pad
 * is exactly that. No source path means _stage_file stores nothing, which is
 * fine — the ink lives in the annotations, not in the file.
 */
async function createWhiteboard(sessionId: string): Promise<string> {
  const data = await readJson(await fetch('/api/artifacts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      kind: 'drawing',
      title: `手绘草稿 ${new Date().toLocaleString('zh-CN', { hour12: false })}`,
      run_id: sessionId,
      agent: 'pilotv-reviewer',
      deliverable: 'aux',
      status: 'ready',
      meta: { whiteboard: true },
    }),
  }), '空白手绘页创建失败');
  const id = data?.artifact?.id || data?.id;
  if (!id) throw new Error('空白手绘页创建失败：返回里没有成果 id');
  return String(id);
}

function SessionArtifacts({ sessionId }: { sessionId: string }) {
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [index, setIndex] = useState(0);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [notes, setNotes] = useState<Annotation[]>([]);
  const [draft, setDraft] = useState<Draft>(null);
  const [draftBody, setDraftBody] = useState('');
  const [activeNoteId, setActiveNoteId] = useState<string | null>(null);
  const [syncState, setSyncState] = useState('');
  const [noteError, setNoteError] = useState('');
  const syncedNotes = useRef<Set<string>>(new Set());

  useEffect(() => {
    const controller = new AbortController();
    setArtifacts([]);
    setIndex(0);
    setStatus('loading');
    setError('');
    void loadSessionArtifacts(sessionId, controller.signal).then(items => {
      if (controller.signal.aborted) return;
      // 一轮里发了好几份的，只给看最后一份；声明了对比组的整组留着。
      setArtifacts(finalArtifacts(items));
      setStatus('ready');
    }).catch(cause => {
      if (controller.signal.aborted) return;
      setStatus('error');
      setError(cause instanceof Error ? cause.message : '成果列表请求失败');
    });
    return () => controller.abort();
  }, [sessionId, refresh]);

  // 刷新后列表可能变短（新一轮的中间过程被收起来了），别停在空位上。
  useEffect(() => {
    setIndex(current => Math.min(current, Math.max(artifacts.length - 1, 0)));
  }, [artifacts.length]);

  const selected = artifacts[index];

  // Notes live on the artifact record, so one read covers new and resolved notes.
  useEffect(() => {
    setNotes([]);
    setDraft(null);
    setDraftBody('');
    setActiveNoteId(null);
    setNoteError('');
    if (!selected?.id) return;
    const controller = new AbortController();
    void fetchArtifactDetail(selected.id, controller.signal)
      .then(detail => { if (!controller.signal.aborted) setNotes(detail.annotations || []); })
      .catch(() => { if (!controller.signal.aborted) setNoteError('标注读取失败'); });
    return () => controller.abort();
  }, [selected?.id]);

  // Push new reviewer notes into this conversation's composer so a rework request
  // never has to be retyped. Notes already synced are remembered per artifact.
  useEffect(() => {
    if (!selected?.id) return;
    const open = notes.filter(note => note.status !== 'resolved' && !syncedNotes.current.has(note.id));
    if (!open.length) return;
    const title = selected.title || selected.file_name || selected.id;
    if (!appendToComposer(buildComposerText(title, open))) {
      setSyncState('未找到对话输入框，标注未同步');
      return;
    }
    open.forEach(note => syncedNotes.current.add(note.id));
    setSyncState(`已把 ${open.length} 条标注同步到对话输入`);
  }, [notes, selected?.id, selected?.title, selected?.file_name]);

  const submitDraft = useCallback(async () => {
    const body = draftBody.trim();
    if (!body) { setNoteError('标注内容不能为空'); return; }
    const strokes = draft?.strokes || null;
    const rect = draft?.rect || null;
    if (!rect && !strokes?.length) { setNoteError('先框选一块区域，或切到手绘画一笔'); return; }
    setNoteError('');
    try {
      // An empty session has no artifact to hang the note on yet.
      const targetId = selected?.id || await createWhiteboard(sessionId);
      await createAnnotation(targetId, { rect, strokes, body, t: draft?.t ?? null });
      if (targetId !== selected?.id) {
        setSyncState('已在空白手绘页上保存，并新建了白板成果');
        setRefresh(value => value + 1);
        setDraft(null);
        setDraftBody('');
        return;
      }
      const detail = await fetchArtifactDetail(targetId);
      setNotes(detail.annotations || []);
      setDraft(null);
      setDraftBody('');
    } catch (cause) {
      setNoteError(cause instanceof Error ? cause.message : '标注保存失败');
    }
  }, [draft, draftBody, selected?.id, sessionId]);

  const sendInk = useCallback((blob: Blob) => {
    const title = selected?.title || selected?.file_name || '空白手绘页';
    const strokes = draft?.strokes?.length || 0;
    const text = `请参考这张手绘标注修改「${title}」${strokes ? `（${strokes} 笔）` : ''}：`;
    setSyncState(appendInkToComposer(blob, text)
      ? '手绘图片已附到对话输入，并附上说明'
      : '未找到对话输入框，手绘未同步');
  }, [selected?.title, selected?.file_name, draft?.strokes]);

  const act = useCallback(async (action: () => Promise<void>) => {
    setNoteError('');
    try { await action(); } catch (cause) { setNoteError(cause instanceof Error ? cause.message : '操作失败'); }
  }, []);

  const resolveNote = (note: Annotation) => {
    if (!selected?.id) return;
    void act(async () => {
      await setAnnotationStatus(selected.id, note.id, note.status === 'resolved' ? 'open' : 'resolved');
      setNotes(await fetchArtifactDetail(selected.id).then(detail => detail.annotations || []));
    });
  };

  const removeNote = (note: Annotation) => {
    if (!selected?.id) return;
    void act(async () => {
      await deleteAnnotation(selected.id, note.id);
      setNotes(await fetchArtifactDetail(selected.id).then(detail => detail.annotations || []));
    });
  };

  const syncOpenNotes = () => {
    const open = notes.filter(note => note.status !== 'resolved');
    if (!open.length) { setSyncState('当前没有未解决的标注'); return; }
    // 用 buildComposerText 而不是裸的 formatNotes：同步块要带上“改什么”的
    // 抬头，否则 Agent 只收到一串条目，不知道该拿它做什么。
    const title = selected ? (selected.title || selected.file_name || selected.id) : '手绘草稿';
    setSyncState(appendToComposer(buildComposerText(title, open)) ? '已把标注同步到对话输入' : '未找到对话输入框，标注未同步');
  };

  const move = (direction: number) => setIndex(current => Math.min(artifacts.length - 1, Math.max(0, current + direction)));

  // No artifact yet is a normal state, not an error: the stage renders a blank
  // sheet and the first stroke creates the whiteboard it is saved on.
  const showStage = status === 'ready' && (selected || artifacts.length === 0);

  return <section aria-label="当前会话成果" className="flex h-full min-h-0 flex-col" onKeyDown={event => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey ||
        (event.target instanceof Element && event.target.closest('input, textarea, select, [contenteditable="true"]'))) return;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      move(event.key === 'ArrowLeft' ? -1 : 1);
    }
  }}>
    {/* 成果展示上方只有标题栏：标题同时就是成果切换器。
        翻页／刷新／工具都浮在画面上沿（ArtifactStage），不再往顶栏塞第二排控件，
        手机上也不会和「对话/成果」那一行叠在一起。 */}
    <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-1.5">
      {artifacts.length ? (
        <>
          <label className="min-w-0 flex-1"><span className="sr-only">选择成果</span>
            <select aria-label="选择成果" className="w-full truncate rounded border border-border bg-background px-2 py-1 text-xs"
              value={selected?.id || ''} onChange={event => setIndex(artifacts.findIndex(item => item.id === event.target.value))}>
              {artifacts.map((item, position) => <option key={`${item.id}-${position}`} value={item.id}>{position + 1}. {item.title || item.file_name || item.id}</option>)}
            </select>
          </label>
        </>
      ) : (
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
          {status === 'loading' ? '正在加载当前会话成果…' : status === 'error' ? error : '当前会话还没有成果'}
        </span>
      )}
    </div>
    {/* 工具和翻页浮在成果画面上沿。不做滑动翻页：框选／手绘都靠拖动手势，
        滑动切页和它们抢同一个手势，误触比多按一次更烦。 */}
    {status === 'loading' && artifacts.length === 0 && <p role="status" className="p-4">正在加载当前会话成果…</p>}
    {status === 'error' && <p role="alert" className="p-4">{error}。请检查成果 API 是否可用后刷新。</p>}

    {showStage && <div className="flex min-h-0 flex-1 flex-col xl:flex-row">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col p-2">
        <ArtifactStage artifact={selected ?? null} annotations={notes} draft={draft} activeNoteId={activeNoteId}
          draftBody={draftBody} draftError={noteError}
          navigation={<>
            <span aria-hidden="true" className="mx-0.5 h-5 w-px bg-border" />
            <button type="button" className="min-h-9 rounded-full border border-transparent px-2.5 text-xs hover:bg-muted disabled:opacity-40" disabled={status !== 'ready' || index <= 0} onClick={() => move(-1)}>上一步</button>
            <span className="whitespace-nowrap text-xs tabular-nums text-muted-foreground" aria-live="polite">{artifacts.length ? `${index + 1} / ${artifacts.length}` : '0 / 0'}</span>
            <button type="button" className="min-h-9 rounded-full border border-transparent px-2.5 text-xs hover:bg-muted disabled:opacity-40" disabled={status !== 'ready' || index >= artifacts.length - 1} onClick={() => move(1)}>下一步</button>
            <button type="button" className="min-h-9 rounded-full border border-transparent px-2.5 text-xs hover:bg-muted" onClick={() => setRefresh(value => value + 1)}>刷新</button>
          </>}
          onDraft={setDraft} onDraftBody={setDraftBody} onSaveDraft={() => { void submitDraft(); }}
          onCancelDraft={() => { setDraft(null); setDraftBody(''); setNoteError(''); }}
          onPickNote={setActiveNoteId} onSendInk={sendInk} />
      </div>
      <aside aria-label="标注" className="flex min-h-0 shrink-0 flex-col gap-2 border-t border-border p-2 xl:w-[320px] xl:border-l xl:border-t-0">
        {noteError && !draft && <p role="alert" className="text-xs text-destructive">{noteError}</p>}
        <div className="flex shrink-0 items-center gap-2 text-xs">
          <span>标注 {notes.filter(note => note.status !== 'resolved').length} 条待处理 / 共 {notes.length} 条</span>
          <button type="button" className="ml-auto min-h-11 rounded border border-border px-2" onClick={syncOpenNotes}>同步到对话输入</button>
        </div>
        <ul className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto text-sm">
          {notes.map(note => <li key={note.id} className={`rounded border border-border p-2 ${note.status === 'resolved' ? 'opacity-60' : ''} ${activeNoteId === note.id ? 'ring-1 ring-ring' : ''}`}>
            <button type="button" className="min-h-9 w-full text-left" onClick={() => setActiveNoteId(note.id)}>
              <span className="font-medium">{note.seq}. {note.body}</span>
              {typeof note.anchor?.t === 'number' && <span className="ml-1 text-xs text-muted-foreground">{Math.round(note.anchor.t)} 秒处</span>}
              {!note.anchor?.rect && !note.anchor?.strokes?.length && <span className="ml-1 text-xs text-muted-foreground">（无位置）</span>}
            </button>
            <div className="mt-1 flex gap-1 text-xs">
              <button type="button" className="min-h-9 rounded border border-border px-2" onClick={() => resolveNote(note)}>{note.status === 'resolved' ? '重新打开' : '标记已解决'}</button>
              <button type="button" className="min-h-9 rounded border border-border px-2" onClick={() => removeNote(note)}>删除</button>
            </div>
          </li>)}
          {!notes.length && <li className="text-xs text-muted-foreground">
            {selected ? '还没有标注：选「框选」拖一块区域，或选「手绘」画一笔。' : '这是空白手绘页，画一笔再加说明就能保存；保存时会自动为本会话建一张白板成果。'}
          </li>}
        </ul>
        {syncState && <p role="status" className="shrink-0 text-xs text-muted-foreground">{syncState}</p>}
      </aside>
    </div>}
  </section>;
}

/**
 * 没有选中对话时，成果页不是空提示，而是一张可以直接画的草稿纸。
 *
 * 笔迹走输入框的附件通道发送：新建的对话由对话输入自己创建（后端收到第一条
 * 消息才建会话），所以这里只需要先把项目切到「新对话」态，再把图片贴进去并
 * 按下发送。发送失败时留在输入框里，宁可让用户自己按一次发送，也不要把草图丢掉。
 */
function NewConversationSketch({ onStartNewConversation }: { onStartNewConversation?: () => void }) {
  const [draft, setDraft] = useState<Draft>(null);
  const [noteError, setNoteError] = useState('');
  const [state, setState] = useState('');
  const [busy, setBusy] = useState(false);

  const sendSketch = useCallback(async (blob: Blob) => {
    if (busy) return;
    setBusy(true);
    setNoteError('');
    setState('正在新建对话并发送草图…');
    try {
      onStartNewConversation?.();
      const sent = await attachInkAndSubmit(blob, '这是我的手绘草图，请按这张图开始做：');
      setState(sent ? '已发送到新对话。' : '草图已放进对话输入框，附件还在上传，按发送即可发出。');
    } catch (cause) {
      setState('');
      setNoteError(cause instanceof Error ? cause.message : '草图发送失败');
    } finally {
      setBusy(false);
    }
  }, [busy, onStartNewConversation]);

  return <section aria-label="当前会话成果" className="flex h-full min-h-0 flex-col">
    <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-1.5">
      <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">没有选中对话 · 画完直接发到新对话</span>
    </div>
    <div className="flex min-h-0 min-w-0 flex-1 flex-col p-2">
      <ArtifactStage artifact={null} annotations={[]} draft={draft} activeNoteId={null}
        draftBody="" draftError={noteError}
        sketchOnly
        sendLabel={busy ? '正在发送…' : '发送到新对话'}
        onDraft={setDraft} onDraftBody={() => {}} onSaveDraft={() => {}}
        onCancelDraft={() => { setDraft(null); setNoteError(''); }}
        onPickNote={() => {}} onSendInk={blob => { void sendSketch(blob); }} />
    </div>
    {state && <p role="status" className="shrink-0 px-3 py-2 text-xs text-muted-foreground">{state}</p>}
  </section>;
}

export default function ArtifactsConsolePane({
  sessionId,
  onStartNewConversation,
}: {
  sessionId?: string;
  onStartNewConversation?: () => void;
}) {
  if (!sessionId) return <NewConversationSketch onStartNewConversation={onStartNewConversation} />;
  // Keying the subtree drops both selection and data before a new session's first render.
  return <SessionArtifacts key={sessionId} sessionId={sessionId} />;
}
