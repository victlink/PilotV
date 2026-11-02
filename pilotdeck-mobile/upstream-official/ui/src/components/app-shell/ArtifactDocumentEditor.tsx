import { useCallback, useMemo, useState } from 'react';
import { EditorView } from '@codemirror/view';
import type { Extension } from '@codemirror/state';
import { useCodeEditorSettings } from '../code-editor/hooks/useCodeEditorSettings';
import { useEditorKeyboardShortcuts } from '../code-editor/hooks/useEditorKeyboardShortcuts';
import { getLanguageExtensions } from '../code-editor/utils/editorExtensions';
import CodeEditorSurface from '../code-editor/view/subcomponents/CodeEditorSurface';
import HtmlDocumentPreview from '../code-editor/view/subcomponents/HtmlDocumentPreview';
import MarkdownPreview from '../code-editor/view/subcomponents/markdown/MarkdownPreview';
import { describeDelta } from './artifactText';
import { artifactRawUrl, type Artifact } from './artifactsMedia';
import { useArtifactTextDocument } from './useArtifactTextDocument';

type Props = {
  artifact: Artifact;
  /** 预览／编辑由成果台浮条控制，编辑器自己不偷偷换挡：改到一半被切走，
   *  人会不知道刚才那半截改动去哪了。 */
  mode: 'preview' | 'edit';
  onExit: () => void;
};

/**
 * 成果台里的一份文档：markdown 渲染、HTML 走沙箱 iframe、纯文本照原样显示，
 * 要改就切到 CodeMirror，保存写回成果台自己的副本。
 *
 * 刻意复用项目编辑器那几件现成件（CodeEditorSurface / MarkdownPreview /
 * HtmlDocumentPreview / editorExtensions / zincThemes），而不是另写一套：
 * 两边的手感、快捷键、主题必须一致，用户不该在成果台里换一套编辑器。
 * CodeEditorSurface 本来就是自己注入 content/onChange/预览地址的，
 * 成果台只要把 /api/artifacts/{id}/text 的正文塞进去即可 ——
 * 项目文件那套 api.readFile/saveFile 的 hook 一行都没碰。
 */
export default function ArtifactDocumentEditor({ artifact, mode, onExit }: Props) {
  const { isDarkMode, wordWrap, showLineNumbers, fontSize } = useCodeEditorSettings();
  const { content, setContent, loading, loadError, reload, saving, saveError, savedAt, delta, isDirty, handleSave } =
    useArtifactTextDocument(artifact.id);
  const [confirmExit, setConfirmExit] = useState(false);

  const fileName = artifact.file_name || artifact.source_path || artifact.title || artifact.id;
  const extension = fileName.toLowerCase().match(/\.[^.\/]+$/)?.[0] || '';
  const isMarkdown = extension === '.md' || extension === '.markdown';
  const isHtml = extension === '.html' || extension === '.htm';

  const extensions = useMemo<Extension[]>(() => [
    ...getLanguageExtensions(fileName),
    // 成果台里的面板普遍很窄，不自动折行的话每行都得横向拖。
    ...(wordWrap ? [EditorView.lineWrapping] : []),
  ], [fileName, wordWrap]);

  // HTML 预览只能指向成果台副本（沙箱 iframe 不读内存里的正文），
  // 所以保存之后要换个 URL 让 iframe 真的重新拉一次 —— 否则改完了切回预览，
  // 看到的还是保存前那版。/raw 对 HTML 是 no-cache，这里加个时间戳只是逼它换地址。
  const htmlPreviewUrl = useMemo(() => {
    const url = artifactRawUrl(artifact);
    return savedAt ? `${url}${url.includes('?') ? '&' : '?'}t=${savedAt}` : url;
  }, [artifact, savedAt]);

  const requestExit = useCallback(() => {
    // 有未保存的改动时不直接退回预览：内容还留在组件里（不会丢），
    // 但用户需要一个明确的确认，否则一次误点就看不见自己写的东西了。
    if (isDirty) { setConfirmExit(true); return; }
    onExit();
  }, [isDirty, onExit]);

  useEditorKeyboardShortcuts({
    onSave: () => { void handleSave(); },
    onClose: requestExit,
    dependency: content,
    // 只有真在编辑时才抢 Ctrl+S：预览模式下按了没意义，
    // 反而会让人以为「预览里的东西也能存」。
    enabled: mode === 'edit',
  });

  // 与发布时那份原件的差异是「已经存进副本的改动」，和当前缓冲区脏不脏是两件事，
  // 所以两种状态分开写，别把没保存的编辑说成已经改在成果里了。
  const changedNote = delta?.edited ? describeDelta(delta) : '';
  const status = (() => {
    if (loading) return '正在读取正文…';
    if (saveError) return saveError;
    if (savedAt) return `已保存到成果台副本（原项目文件未改动）${changedNote ? `，${changedNote}` : ''}`;
    if (isDirty) return changedNote ? `有未保存的改动；副本已${changedNote}` : '有未保存的改动';
    if (changedNote) return `这份副本相对发布时${changedNote}`;
    return '可直接编辑；改动只写进成果台副本，不动原项目文件';
  })();

  // 预览画的是内存里的正文：没保存的改动也看得见，
  // 否则「预览」永远在回答保存之前的样子，改一句对不上号。
  const previewBody = isMarkdown
    ? <div className="h-full overflow-y-auto bg-white px-6 py-4 dark:bg-neutral-950">
      <div className="prose prose-sm prose-neutral mx-auto max-w-none dark:prose-invert prose-headings:font-semibold prose-a:text-neutral-900 prose-a:underline prose-code:text-[13px] prose-pre:bg-neutral-900 prose-img:rounded-lg dark:prose-a:text-neutral-100">
        <MarkdownPreview content={content} />
      </div>
    </div>
    // 沙箱照旧：allow-same-origin 不给，成果里的脚本碰不到 PilotV 的源。
    // 侧栏的服务端 CSP sandbox 头是同一道锁的另一半，两边都要在。
    : isHtml
      ? <HtmlDocumentPreview url={htmlPreviewUrl} title={`预览：${fileName}`} />
      // 纯文本没有渲染可谈，如实照原样摆出来：至少滚动、等宽、不再是源码乱流。
      : <pre className="h-full overflow-auto whitespace-pre-wrap break-words bg-white p-4 font-mono text-xs text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100">{content}</pre>;

  // 读不出正文时编辑区是空的：真让人往里写就等于把成果清空。
  // 所以只说清为什么不能用；理由和「重试」都在顶上那一条里，不在这里重复一遍。
  const readFailure = <p className="p-4 text-sm text-muted-foreground">
    正文没读出来，编辑和保存都用不了。修好之后点上方的「重试」。
  </p>;

  return <div className="flex h-full w-full flex-col overflow-hidden">
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-2 py-1.5 text-xs">
      <span className="min-w-0 truncate font-medium" title={fileName}>{fileName}</span>
      <span role="status" className="min-w-0 flex-1 truncate text-muted-foreground">{status}</span>
      {loadError && <button type="button" className="min-h-9 rounded border border-border px-2" onClick={reload}>重试</button>}
      {mode === 'edit' && <>
        <button type="button" className="min-h-9 rounded border border-border px-2 disabled:opacity-40"
          disabled={saving || loading || Boolean(loadError)} onClick={() => { void handleSave(); }}>
          {saving ? '保存中…' : '保存'}
        </button>
        <button type="button" className="min-h-9 rounded border border-border px-2" onClick={requestExit}>退出编辑</button>
      </>}
    </div>

    {mode === 'edit' && confirmExit && <div role="alert" className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border bg-muted/60 px-2 py-1.5 text-xs">
      <span className="min-w-0 flex-1">还有没保存的改动，先存了再退出？</span>
      {/* 存不进去就别退出：退出等于把编辑区收掉，而错误提示也在同一块屏幕上，
          人会只看到成果又变回旧内容，说不清是自己改丢了还是没存上。 */}
      <button type="button" className="min-h-9 rounded border border-border px-2" onClick={async () => { if (await handleSave()) onExit(); }}>保存并退出</button>
      <button type="button" className="min-h-9 rounded border border-border px-2" onClick={() => { setConfirmExit(false); onExit(); }}>放弃改动</button>
      <button type="button" className="min-h-9 rounded border border-border px-2" onClick={() => setConfirmExit(false)}>继续编辑</button>
    </div>}

    {/* 就地编辑不进版本链，所以这份 unified diff 是「成果台里改了什么」唯一的
        记录：没有它，评审在副本上做的改动在成果台里没有任何地方看得见。
        收起来默认不占地方，但得摆在那儿。 */}
    {delta?.edited && delta.diff && <details className="shrink-0 border-b border-border px-2 py-1 text-xs">
      <summary className="cursor-pointer text-muted-foreground">
        相对发布时的改动（{describeDelta(delta)}{delta.truncated ? '，差异太长已截断' : ''}）
      </summary>
      <pre className="mt-1 max-h-48 overflow-auto whitespace-pre rounded bg-muted/50 p-2 font-mono text-[11px] leading-snug">
        {delta.diff.split('\n').map((line, index) => (
          // 纯文本渲染，不解释成 HTML：diff 里就是文档正文，别让谁写的标记在这里生效。
          <span key={index} className={line.startsWith('+') ? 'text-emerald-700 dark:text-emerald-400'
            : line.startsWith('-') ? 'text-destructive' : 'text-muted-foreground'}>{line}{'\n'}</span>
        ))}
      </pre>
    </details>}

    {/* 正文区是竖排：出错提示条排在最上面，编辑器／沙箱 iframe 拿剩下的高度。
        写成一块会变成「提示条 + 100% 高的 iframe」，底部被裁掉一截。 */}
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      {loading
        ? <p className="p-4 text-sm text-muted-foreground">正在读取正文…</p>
        : mode === 'edit'
          ? loadError ? readFailure : <div className="min-h-0 flex-1 overflow-hidden"><CodeEditorSurface
            content={content}
            onChange={setContent}
            markdownPreview={false}
            isMarkdownFile={isMarkdown}
            htmlPreview={false}
            isHtmlFile={isHtml}
            fileName={fileName}
            isDarkMode={isDarkMode}
            fontSize={fontSize}
            showLineNumbers={showLineNumbers}
            extensions={extensions}
          /></div>
          // 读不到正文时预览不能整个收成一句报错：/text 拒收的文档（已经超过 2MB、
          // 后缀不在可编辑清单里）以前是看得见的 —— 那时 markdown／HTML 都直接走
          // /raw 的 iframe。把那条旧路接回来当兜底，HTML 仍是同样隔离的沙箱，
          // markdown 退回成源码；总比让人以为成果丢了强。
          : <>
            {loadError && <p role="alert" className="shrink-0 border-b border-border bg-destructive/10 px-3 py-1.5 text-xs text-destructive">
              {loadError}。下面显示的是原文件，未经成果台渲染。
            </p>}
            <div className="min-h-0 flex-1 overflow-hidden">
              {loadError
                ? <HtmlDocumentPreview url={artifactRawUrl(artifact)} title={`原文件：${fileName}`} />
                : previewBody}
            </div>
          </>}
    </div>
  </div>;
}
