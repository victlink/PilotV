import { describe, expect, it } from 'vitest';
import { contracts, isNativeModule, parseParams, substitute } from '../src/native/contracts';

describe('native gateway contracts', () => {
  it('has explicit parity status for all eight modules', () => {
    expect(Object.keys(contracts)).toEqual(['workspaces', 'agents', 'tasks', 'files', 'memory', 'plugins', 'settings', 'logs']);
    for (const contract of Object.values(contracts)) expect(Array.isArray(contract.unavailable)).toBe(true);
    expect(contracts.memory.actions).toEqual([]);
    expect(isNativeModule('tasks')).toBe(true);
    expect(isNativeModule('mcp')).toBe(false);
  });
  it('uses only dispatcher-supported methods and capability guards', () => {
    const supported = new Set(['list_projects', 'describe_project', 'list_sessions', 'new_session', 'close_project_sessions', 'resume_session', 'read_subagent_messages', 'active_turn_snapshot', 'close_session', 'fork_session', 'cron_list', 'cron_create', 'cron_update', 'cron_run_now', 'cron_stop', 'cron_delete', 'project_files_list', 'skill_list', 'skill_read', 'skill_create', 'skill_write', 'skill_validate', 'skill_scan', 'skill_import', 'skill_delete', 'reload_extensions', 'describe_server', 'model_catalog_list', 'session_model_get', 'session_model_set', 'session_model_clear', 'reload_config', 'read_session_messages']);
    for (const contract of Object.values(contracts)) for (const action of [...(contract.list ? [contract.list] : []), ...contract.actions]) expect(supported.has(action.method), action.method).toBe(true);
    expect(contracts.files.list?.capability).toBe('project_files_list');
  });
  it('substitutes nested scope without changing unrelated text', () => {
    expect(substitute({ path: '$projectKey', nested: ['$sessionKey', 'abc$projectKey'] }, { projectKey: '/p', sessionKey: 's' })).toEqual({ path: '/p', nested: ['s', 'abc$projectKey'] });
  });
  it('refuses non-object JSON forms', () => {
    expect(parseParams('{"projectKey":"/p"}')).toEqual({ projectKey: '/p' });
    expect(() => parseParams('[]')).toThrow('JSON 对象');
    expect(() => parseParams('null')).toThrow('JSON 对象');
  });
});
