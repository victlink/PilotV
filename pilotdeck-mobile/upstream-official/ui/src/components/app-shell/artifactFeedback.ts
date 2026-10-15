// Merge the console's reviewer feedback into this app's chat composer.
// The composer is a controlled React textarea, so write through the native value
// setter and dispatch an input event the way React listens for it.
export type FeedbackNote = {
  id: string;
  seq?: number | null;
  severity?: string | null;
  body?: string | null;
  surface?: string | null;
};

export function formatNotes(notes: FeedbackNote[]): string {
  return notes.map(note => {
    const severity = note.severity === 'blocker' ? '必须改' : note.severity === 'nit' ? '建议' : '问题';
    const surface = note.surface ? `（${note.surface}）` : '';
    return `- [${severity}] ${note.body ?? ''}${surface}`;
  }).join('\n');
}

export function buildComposerText(title: string, notes: FeedbackNote[]): string {
  return `请根据成果标注修改「${title}」：\n${formatNotes(notes)}`;
}

// The console is a sibling pane with its own textareas (the annotation draft
// box is a <textarea> too), so "first textarea on the page" can land in the
// wrong control and silently write the message into the note box.
const COMPOSER_HINT = /tell pilotdeck|what you want|消息|发送|ask/i;

/** Find the chat composer, never the console's own note fields. */
function findComposer(): HTMLTextAreaElement | null {
  const insideConsole = (node: Element) => Boolean(node.closest('[aria-label="当前会话成果"]'));
  const candidates = Array.from(document.querySelectorAll<HTMLTextAreaElement>('textarea'))
    .filter(node => !insideConsole(node) && !node.id.startsWith('artifact-'));
  // The composer renders inside the chat form, so prefer that subtree.
  const inForm = candidates.find(node => node.closest('form')?.contains(node));
  if (inForm) return inForm;
  return candidates.find(node => COMPOSER_HINT.test(node.placeholder)) ?? null;
}

/**
 * The block this pane last pushed, per composer. "同步到对话输入" is pressed
 * again after every new annotation, and blind appending stacks the same
 * instruction list two or three times in one message. Remembering what we wrote
 * lets the next sync replace it, and leaves no marker in the user's text.
 */
const lastSync = new WeakMap<HTMLTextAreaElement, string>();

/** Replace this pane's previous block, leaving anything the user typed. */
export function appendToComposer(text: string): boolean {
  const composer = findComposer();
  if (!composer) return false;
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
  if (!setter) return false;
  const block = text.trim();
  if (!block) return false;
  const previous = lastSync.get(composer) ?? '';
  const current = composer.value;
  const kept = previous && current.includes(previous)
    ? current.replace(previous, '').trim()
    : current.trim();
  const next = kept ? `${kept}\n\n${block}` : block;
  lastSync.set(composer, block);
  setter.call(composer, next);
  composer.dispatchEvent(new Event('input', { bubbles: true }));
  composer.focus();
  return true;
}

/**
 * Attach a rendered sketch to the composer as an image.
 *
 * The composer has no imperative "add image" handle, but its paste handler
 * already reads files off `clipboardData` (useChatComposerState.handlePaste) and
 * runs them through the same attachment upload as the paperclip. Dispatching a
 * paste therefore lands the drawing in the real attachment pipeline instead of
 * inlining a data URL as text the agent could never see. Returns false when the
 * browser refuses to build the event, so the caller can degrade to text only.
 */
export function appendInkToComposer(blob: Blob, text: string, name = '手绘标注.png'): boolean {
  const composer = findComposer();
  if (!composer) return false;
  const file = new File([blob], name, { type: 'image/png' });
  const transfer = new DataTransfer();
  transfer.items.add(file);
  const event = new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true });
  composer.dispatchEvent(event);
  if (text.trim()) appendToComposer(text);
  composer.focus();
  return true;
}

/**
 * Press the composer's own send button.
 *
 * The chat surface owns message state; nothing outside it may call
 * `sendMessage` for a session that the backend has not created yet. Going
 * through the form's submit event keeps validation, the attachment wait and
 * the temporary-session creation in the one place that already handles them.
 */
export function submitComposer(): boolean {
  const form = findComposer()?.closest('form');
  if (!form || !form.isConnected) return false;
  form.requestSubmit();
  return true;
}

/**
 * Attach, then wait for the composer to accept it.
 *
 * `appendInkToComposer` only queues the upload; sending in the same tick would
 * drop the image because the send button is still disabled. Poll the button
 * instead of guessing a delay so a slow upload still gets sent.
 */
export async function attachInkAndSubmit(
  blob: Blob,
  text: string,
  name = '手绘草稿.png',
  timeoutMs = 8000,
): Promise<boolean> {
  if (!appendInkToComposer(blob, text, name)) return false;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const button = findComposer()?.closest('form')?.querySelector<HTMLButtonElement>('button[type="submit"]');
    if (button && !button.disabled) {
      button.form?.requestSubmit();
      return true;
    }
    await new Promise(resolve => { setTimeout(resolve, 120); });
  }
  // The upload never finished. Leave it in the box rather than sending text
  // alone, so the drawing is not silently dropped.
  return false;
}

export async function loadOpenNotes(artifactId: string, signal?: AbortSignal): Promise<FeedbackNote[]> {
  const response = await fetch(`/api/artifacts/${encodeURIComponent(artifactId)}/feedback?status=open`, { signal });
  if (!response.ok) throw new Error(`标注读取失败（HTTP ${response.status}）`);
  const data = (await response.json()) as { annotations?: FeedbackNote[] };
  return Array.isArray(data.annotations) ? data.annotations : [];
}