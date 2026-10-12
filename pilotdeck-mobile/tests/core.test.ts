import { describe, expect, it } from 'vitest';
import { parseConfig, createScope, type ConfigInput } from '../src/core';
const valid: ConfigInput = { name: '本地', rest: 'http://localhost:8787', ws: 'ws://localhost:8787/ws', mcp: '', token: '', notes: '', rememberToken: false };
describe('instance validation', () => {
  it('accepts valid REST/WS pair and normalizes slash', () => expect(parseConfig({ ...valid, rest: valid.rest + '/' }).rest).toBe(valid.rest));
  it('rejects unsafe protocols and missing labels', () => {
    expect(() => parseConfig({ ...valid, rest: 'file:///etc/passwd' })).toThrow();
    expect(() => parseConfig({ ...valid, ws: 'https://localhost' })).toThrow();
    expect(() => parseConfig({ ...valid, name: '   ' })).toThrow();
    expect(() => parseConfig({ ...valid, mcp: 'javascript:alert(1)' })).toThrow();
  });
});
describe('switch isolation', () => {
  it('rejects pending work, closes socket and aborts fetch on switch', async () => {
    const scope = createScope();
    const controller = scope.controller();
    let closed = false;
    scope.onClose(() => { closed = true; });
    const pending = scope.pending('a');
    scope.dispose();
    await expect(pending.promise).rejects.toThrow('实例已切换');
    expect(closed).toBe(true);
    expect(controller.signal.aborted).toBe(true);
    expect(scope.active()).toBe(false);
  });
  it('does not accept completion from an old epoch', () => {
    const old = createScope();
    old.dispose();
    expect(old.active()).toBe(false);
    expect(createScope().active()).toBe(true);
  });
});
