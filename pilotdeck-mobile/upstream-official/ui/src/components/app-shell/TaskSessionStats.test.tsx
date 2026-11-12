// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../chat/view/useTurnTaskElapsed', () => ({
  useTurnTaskElapsedFromSocket: () => null,
  useSessionContextUsageFromSocket: () => null,
}));
vi.mock('./TaskMonitorPanel', () => ({ formatElapsed: (n: number) => String(n) }));
import TaskSessionStats from './TaskSessionStats';
afterEach(cleanup);
it('keeps both header chips visible with explicit unknown values', () => {
  render(<TaskSessionStats sessionId={null} />);
  expect(screen.getByTestId('current-task-elapsed').textContent).toBe('—');
  expect(screen.getByTestId('current-context-usage').textContent).toBe('—');
});
