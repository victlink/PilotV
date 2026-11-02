// @vitest-environment jsdom
import { matchPath } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import {
  DEDICATED_TAB_PATHS,
  LEGACY_SESSION_PATH,
  PROJECT_CHAT_PATH,
  PROJECT_PATH,
  SCHEDULED_TASKS_PATH,
  SKILLS_PATH,
  getDedicatedTabPath,
  resolveDedicatedTab,
} from './appRoutes';

describe('appRoutes 专用页', () => {
  it('keeps the skills and scheduled task paths', () => {
    // 项目室撤掉了：每个对话自己就是一个项目室，不再有 /rooms 专用页。
    expect(getDedicatedTabPath('rooms')).toBeUndefined();
    expect(getDedicatedTabPath('skills')).toBe(SKILLS_PATH);
    expect(getDedicatedTabPath('cron')).toBe(SCHEDULED_TASKS_PATH);
    expect(DEDICATED_TAB_PATHS.skills).toBe(SKILLS_PATH);
    expect(DEDICATED_TAB_PATHS.cron).toBe(SCHEDULED_TASKS_PATH);
  });

  it('does not treat ordinary tabs as dedicated pages', () => {
    expect(getDedicatedTabPath('chat')).toBeUndefined();
    expect(getDedicatedTabPath('rooms2')).toBeUndefined();
  });

  it('maps a matched path to its dedicated tab', () => {
    expect(resolveDedicatedTab({ skills: true })).toBe('skills');
    expect(resolveDedicatedTab({ cron: true })).toBe('cron');
    expect(resolveDedicatedTab({})).toBeNull();
  });
});

describe('appRoutes 会话路由', () => {
  it('keeps both session url shapes working', () => {
    // 项目的会话深链。
    expect(matchPath(PROJECT_CHAT_PATH, '/p/demo/c/sess-1')).toMatchObject({
      params: { projectName: 'demo', sessionId: 'sess-1' },
    });
    // 只到项目的页面。
    expect(matchPath(PROJECT_PATH, '/p/demo')).toMatchObject({
      params: { projectName: 'demo' },
    });
    // 老的老会话链接。
    expect(matchPath(LEGACY_SESSION_PATH, '/session/sess-1')).toMatchObject({
      params: { sessionId: 'sess-1' },
    });
  });

  it('does not swallow the session routes', () => {
    expect(matchPath(PROJECT_CHAT_PATH, '/rooms')).toBeNull();
    expect(matchPath(LEGACY_SESSION_PATH, '/rooms')).toBeNull();
  });
});
