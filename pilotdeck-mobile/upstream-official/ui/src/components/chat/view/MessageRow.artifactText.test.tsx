// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '../types/types';
import MessageRow from './MessageRow';
import { TurnFileFooter } from './TurnFileFooter';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue || key,
  }),
}));

afterEach(cleanup);

describe('MessageRow generated file presentation', () => {
  it.each([undefined, true, false])('preserves artifact Markdown navigation with showInlineTurnChanges=%s', (showInlineTurnChanges) => {
    const fileName = '今日热点-2026-08-0803.docx';
    const filePath = `reports/${fileName}`;
    const message: ChatMessage = {
      id: 'assistant-file-result',
      entryId: 'assistant-file-result',
      type: 'assistant',
      content: `已完成今日热点总结并生成文件：[${fileName}](${fileName})`,
      timestamp: '2026-08-03T08:00:00.000Z',
      artifacts: [{
        id: 'artifact-1',
        name: fileName,
        path: filePath,
        operation: 'created',
        source: 'workspace_diff',
        status: 'complete',
        size: 1024,
        sha256: 'sha256',
        createdAt: '2026-08-03T08:00:00.000Z',
      }],
    };

    const { container } = render(
      <>
      <MessageRow
        message={message}
        prevMessage={null}
        provider="pilotdeck"
        selectedProject={{
          name: 'office',
          displayName: 'office',
          fullPath: '/workspace/office',
        }}
        createDiff={() => []}
        onFileOpen={vi.fn()}
        showAssistantActions={false}
        showInlineTurnChanges={showInlineTurnChanges}
      />
      <TurnFileFooter files={{ artifacts: message.artifacts!, visible: true }} project={{
        name: 'office', displayName: 'office', fullPath: '/workspace/office',
      }} onBrowse={vi.fn()} />
      </>,
    );

    expect(screen.queryByRole('link', { name: fileName })).toBeNull();
    expect(screen.getByText(`已完成今日热点总结并生成文件：${fileName}`)).toBeTruthy();
    const card = container.querySelector(`[data-file-artifact="${filePath}"]`);
    expect(card).not.toBeNull();
    expect(card?.textContent).toContain(fileName);
    expect(screen.getAllByTestId('turn-changes-card')).toHaveLength(showInlineTurnChanges === false ? 1 : 2);
  });

  it.each([undefined, false])('passes showInlineTurnChanges=%s into process attachment details', (showInlineTurnChanges) => {
    const detail: ChatMessage = {
      id: 'nested-file-result', type: 'assistant', timestamp: '2026-08-03T08:00:00.000Z',
      content: 'Generated [report.txt](report.txt)',
      artifacts: [{ id: 'nested-artifact', name: 'report.txt', path: 'reports/report.txt',
        operation: 'created', source: 'workspace_diff', status: 'complete', size: 42,
        sha256: 'sha256', createdAt: '2026-08-03T08:00:00.000Z' }],
    };
    render(<MessageRow message={{ ...detail, id: 'host', content: 'Done.', artifacts: [] }}
      prevMessage={null} provider="pilotdeck" selectedProject={null} createDiff={() => []}
      showInlineTurnChanges={showInlineTurnChanges} isProcessExpanded={() => true}
      beforeProcessAttachments={[{ id: 'attachment', processSummary: { ...detail, artifacts: [] },
        processMessages: [detail], processDetailMessages: [detail], startIndex: 0, endIndex: 0, inlineImages: [] }]} />);
    expect(screen.queryByRole('link', { name: 'report.txt' })).toBeNull();
    expect(screen.getByText('Generated report.txt')).toBeTruthy();
    expect(screen.queryAllByTestId('turn-changes-card')).toHaveLength(showInlineTurnChanges === false ? 0 : 1);
  });
});
