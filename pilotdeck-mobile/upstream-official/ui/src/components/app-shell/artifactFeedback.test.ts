import { expect, it } from 'vitest';
import { buildComposerText, formatNotes } from './artifactFeedback';

it('formats reviewer notes with severity and surface', () => {
  expect(formatNotes([
    { id: 'a', severity: 'blocker', body: '尺寸错了', surface: '主视图' },
    { id: 'b', severity: 'nit', body: '配色' },
  ])).toBe('- [必须改] 尺寸错了（主视图）\n- [建议] 配色');
});

it('builds a composer message that names the artifact', () => {
  const text = buildComposerText('面板截图', [{ id: 'a', body: '标题溢出' }]);
  expect(text).toContain('「面板截图」');
  expect(text).toContain('标题溢出');
});