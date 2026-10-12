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

export function appendToComposer(text: string): boolean {
  const composer = document.querySelector<HTMLTextAreaElement>('textarea[placeholder]')
    ?? Array.from(document.querySelectorAll<HTMLTextAreaElement>('textarea')).find(node =>
      node.placeholder.includes('消息') || node.placeholder.includes('Ask') || node.placeholder.includes('发送'));
  if (!composer) return false;
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
  if (!setter) return false;
  const existing = composer.value.trim();
  const next = existing ? `${existing}\n\n${text}` : text;
  setter.call(composer, next);
  composer.dispatchEvent(new Event('input', { bubbles: true }));
  composer.focus();
  return true;
}

export async function loadOpenNotes(artifactId: string, signal?: AbortSignal): Promise<FeedbackNote[]> {
  const response = await fetch(`/api/artifacts/${encodeURIComponent(artifactId)}/feedback?status=open`, { signal });
  if (!response.ok) throw new Error(`标注读取失败（HTTP ${response.status}）`);
  const data = (await response.json()) as { annotations?: FeedbackNote[] };
  return Array.isArray(data.annotations) ? data.annotations : [];
}