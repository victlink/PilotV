import test from 'node:test';
import assert from 'node:assert/strict';
import { projectTaskPolicy } from './projectTaskPolicy.js';
import { dispatchProjectTasks } from './ProjectTeamDispatch.js';
import { PermissionRuntime } from '../../permission/index.js';
import type { PilotDeckToolDefinition, PilotDeckToolRuntimeContext } from '../../tool/index.js';

test('delegation preserves scoped allow rules and denies approvals without a prompt channel', () => {
  const rules = projectTaskPolicy({ allow: ['bash:git log:*', 'mcp__docs'], deny: ['write_file'], ask: ['bash:git push:*'] });
  assert.deepEqual(rules.allowList?.map(r => r.toolName), ['bash', 'mcp__docs']);
  assert.equal(rules.allowList?.[0]?.pattern, 'git log:*');
  assert.ok(rules.deny.some(r => r.toolName === 'bash' && r.pattern === 'git push:*'));
  assert.ok(rules.deny.some(r => r.toolName === 'write_file'));
});

test('approval rules remain denied even in a bypass delegated runtime', async () => {
  const runtime = new PermissionRuntime();
  const context: PilotDeckToolRuntimeContext = { sessionId: 'fixture', turnId: 'fixture', cwd: process.cwd(), permissionMode: 'bypassPermissions', permissionContext: { mode: 'bypassPermissions', cwd: process.cwd(),
    rules: projectTaskPolicy({ allow: ['bash:git log:*', 'bash:git push:*'], ask: ['bash:git push:*'] }),
    additionalWorkingDirectories: [], canPrompt: false, bypassAvailable: true } };
  const tool: PilotDeckToolDefinition = { name: 'bash', kind: 'shell', description: 'fixture',
    inputSchema: { type: 'object' }, isReadOnly: () => false, isConcurrencySafe: () => false,
    execute: async () => ({ content: [] }) };
  assert.equal((await runtime.decide(tool, { command: 'git push origin main' }, context, 'push')).type, 'deny');
  assert.equal((await runtime.decide(tool, { command: 'rm -rf anything' }, context, 'escape')).type, 'deny');
});

test('network-only and scoped members are not falsely considered revoked', async () => {
  for (const allow of [['web_fetch'], ['mcp__docs'], ['bash:git log:*'], ['*']]) {
    let executed = false;
    const member = { id: 'worker', briefing: '', toolPolicy: { allow } };
    const results = await dispatchProjectTasks([{ id: 'task', memberId: 'worker', directive: 'inspect', dependsOn: [] }], {
      projectRoot: '.', members: [member], resolveMember: async () => member,
    }, undefined, undefined, async () => { executed = true; return { report: 'ok' }; });
    assert.equal(executed, true, JSON.stringify(results));
    assert.equal(results[0]?.status, 'completed');
  }
});
