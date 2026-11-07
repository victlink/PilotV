// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AuthDevicePicker from './AuthDevicePicker';

const SERVERS = [
  { name: 'nas', origin: 'http://100.90.196.104:3001' },
  { name: 'jx88', origin: 'http://100.108.86.109:3001' },
];

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const target = String(url);
      if (target.startsWith('/api/pilotv/devices')) {
        return { ok: true, status: 200, json: async () => ({ devices: SERVERS, writable: true }) };
      }
      return { ok: true, status: 200, json: async () => ({ devices: SERVERS }) };
    }),
  );
  (window as unknown as { __PILOTV__?: unknown }).__PILOTV__ = {
    backend: 'http://100.90.196.104:3001',
    device: { name: 'nas', origin: 'http://100.90.196.104:3001' },
    defaultBackend: 'http://127.0.0.1:3001',
    defaultName: '当前设备',
  };
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  delete (window as unknown as { __PILOTV__?: unknown }).__PILOTV__;
});

describe('登录页上的设备切换器', () => {
  it('停在登录页时也要说清楚现在连的是哪台，并能切走', async () => {
    render(<AuthDevicePicker />);

    const current = screen.getByTitle('http://100.90.196.104:3001');
    expect(current.textContent).toBe('nas');

    const select = screen.getByLabelText('选择设备') as HTMLSelectElement;
    expect(select.value).toBe('http://100.90.196.104:3001');
    await waitFor(() =>
      expect(Array.from(select.options).map(option => option.textContent)).toContain('jx88')
    );
  });
});
