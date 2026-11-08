import { describe, expect, it } from 'vitest';
import { isApprovalInactive, isHighRisk, originSessionUrl, sortApprovalRequests, supportedApprovalChannel } from './approvalSession';

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
