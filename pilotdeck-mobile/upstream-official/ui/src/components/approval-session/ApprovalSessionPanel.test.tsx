import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { authenticatedFetch } from '../../utils/api';
import { isApprovalInactive, isHighRisk, originSessionUrl, sortApprovalRequests, supportedApprovalChannel } from './approvalSession';
import ApprovalSessionPanel from './ApprovalSessionPanel';

vi.mock('../../utils/api', async () => {
  const actual = await vi.importActual<typeof import('../../utils/api')>('../../utils/api');
  return { ...actual, authenticatedFetch: vi.fn() };
});

const mockFetch = vi.mocked(authenticatedFetch);

const request = (overrides: Record<string, unknown>) => ({
  id: 'r1',
  requestId: 'r1',
  sessionId: 's1',
  projectName: 'PilotV',
  projectKey: 'PilotV',
  kind: 'permission',
  toolName: 'Bash',
  summary: '执行命令',
  createdAt: '2025-01-01T00:00:00Z',
  updatedAt: '2025-01-01T00:00:00Z',
  state: 'pending',
  ...overrides,
});

const renderWith = async (requests: unknown[]) => {
  mockFetch.mockResolvedValue({
    ok: true,
    json: async () => ({
      session: { id: 'approval-center', title: '审核', channelBinding: { enabled: false, channelKey: 'feishu', chatId: '', approverIds: [] } },
      requests,
    }),
  } as unknown as Response);
  render(<ApprovalSessionPanel />);
  await waitFor(() => expect(screen.queryByText(/正在加载审核/)).toBeNull());
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('approval session', () => {
  it('sorts newest updates first and only supports configured channels', () => {
    const rows = [{ updatedAt: '2025-01-01T00:00:00Z' }, { updatedAt: '2025-01-02T00:00:00Z' }] as any;
    expect(sortApprovalRequests(rows)[0].updatedAt).toBe('2025-01-02T00:00:00Z');
    expect(supportedApprovalChannel('feishu')).toBe(true);
    expect(supportedApprovalChannel('weixin')).toBe(false);
  });
  it('guards inactive and high-risk requests and keeps origin metadata typed', () => {
    expect(isHighRisk('high')).toBe(true);
    expect(isHighRisk('critical')).toBe(true);
    expect(isHighRisk('medium')).toBe(false);
    expect(isApprovalInactive({ state: 'pending', expiresAt: '2020-01-01T00:00:00Z' } as any, Date.parse('2021-01-01T00:00:00Z'))).toBe(true);
    expect(isApprovalInactive({ state: 'cancelled' } as any)).toBe(true);
    expect(originSessionUrl({ context: { originUrl: '/sessions/source-1' } } as any)).toBe('/sessions/source-1');
    expect(originSessionUrl({ context: 'invalid' } as any)).toBeNull();
  });
});

describe('approval session panel', () => {
  it('renders the server risk and blocks the allow button for a high risk request', async () => {
    await renderWith([
      request({ risk: 'high', context: { originUrl: '/sessions/source-1' } }),
    ]);
    expect(await screen.findByText(/风险：high/)).toBeTruthy();
    expect((screen.getByRole('button', { name: /允许/ }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: /拒绝/ }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByRole('link', { name: /回来源会话独立确认/ })).toBeTruthy();
  });

  it('does not re-derive the risk from the tool name and keeps low risk requests actionable', async () => {
    // The tool name alone would look dangerous, but the authoritative backend
    // classified the request as `low`: the client must not decide on its own.
    await renderWith([request({ toolName: 'Bash', risk: 'low' })]);
    expect(await screen.findByText(/风险：low/)).toBeTruthy();
    expect((screen.getByRole('button', { name: /允许/ }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('shows the redacted payload preview instead of the raw request content', async () => {
    await renderWith([
      request({ payloadPreview: '{"note":"[redacted]"}', payloadRedacted: true }),
    ]);
    expect(await screen.findByText('{"note":"[redacted]"}')).toBeTruthy();
    expect(screen.getByText(/敏感字段已由后端脱敏/)).toBeTruthy();
  });

  it('keeps a decided request read-only', async () => {
    await renderWith([request({ state: 'approved', risk: 'low' })]);
    await waitFor(() => expect(screen.queryByText(/正在加载审核/)).toBeNull());
    expect((screen.getByRole('button', { name: /允许/ }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: /拒绝/ }) as HTMLButtonElement).disabled).toBe(true);
  });
});
