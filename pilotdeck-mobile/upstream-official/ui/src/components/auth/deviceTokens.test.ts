import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearTokenFor, readTokenFor, writeTokenFor } from './deviceTokens';

describe('每台设备独立保存令牌', () => {
  beforeEach(() => { localStorage.clear(); });
  afterEach(() => { localStorage.clear(); });

  it('不同后端各自存取，互不覆盖', () => {
    writeTokenFor('http://a:3001', 'token-a');
    writeTokenFor('http://b:3001', 'token-b');
    expect(readTokenFor('http://a:3001')).toBe('token-a');
    expect(readTokenFor('http://b:3001')).toBe('token-b');
  });

  it('只清除指定设备，其它设备不受影响', () => {
    writeTokenFor('http://a:3001', 'token-a');
    writeTokenFor('http://b:3001', 'token-b');
    clearTokenFor('http://a:3001');
    expect(readTokenFor('http://a:3001')).toBeNull();
    expect(readTokenFor('http://b:3001')).toBe('token-b');
  });

  it('旧版 auth-token 会被认领到当前设备，不丢已有登录态', () => {
    localStorage.setItem('auth-token', 'legacy-token');
    expect(readTokenFor('http://a:3001')).toBe('legacy-token');
    expect(readTokenFor('http://b:3001')).toBe('legacy-token');
    writeTokenFor('http://a:3001', 'token-a');
    expect(readTokenFor('http://b:3001')).toBe('legacy-token');
  });

  it('令牌表损坏时按空表处理，不让页面崩掉', () => {
    localStorage.setItem('pilotdeck-tokens', '{坏数据');
    expect(readTokenFor('http://a:3001')).toBeNull();
    writeTokenFor('http://a:3001', 'token-a');
    expect(readTokenFor('http://a:3001')).toBe('token-a');
  });

  it('没有令牌时返回 null', () => {
    expect(readTokenFor('http://a:3001')).toBeNull();
  });
});