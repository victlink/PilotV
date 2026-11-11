import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AgentLoop } from '../loop/AgentLoop.js';
import { createRouterRuntime } from '../../router/RouterRuntime.js';
import type { CanonicalModelEvent, CanonicalModelRequest, ModelRuntime } from '../../model/index.js';
import { ToolRegistry } from '../../tool/registry/ToolRegistry.js';
import { ToolRuntime } from '../../tool/execution/ToolRuntime.js';
import { ConcurrentToolScheduler } from '../../tool/scheduler/ConcurrentToolScheduler.js';
import { createAgentTool } from '../../tool/builtin/agent.js';
import { createBuiltinRegistry } from '../../tool/registry/createBuiltinRegistry.js';
import { dispatchProjectTasks, type ProjectTeamDispatch } from './ProjectTeamDispatch.js';
import { createSubagentGate } from './subagentConcurrency.js';
import { PermissionRuntime } from '../../permission/index.js';

const task = (id: string, dependsOn: string[] = [], memberId = 'worker') => ({ id, memberId, directive: id, dependsOn });

for (const scenario of ['auto', 'dag', 'cycle', 'disabled', 'solo', 'noAuthority', 'wrongRoot', 'scope', 'duplicate', 'unknown', 'self', 'empty'] as const) {
  test(`team dispatch: ${scenario}`, { timeout: 5000 }, async () => {
    const parent = await mkdtemp(join(process.env.WORKSPACES_ROOT!, 'team-'));
    const cwd = await mkdtemp(join(parent, 'project-'));
    await writeFile(join(parent, 'secret.txt'), 'OUTSIDE_SECRET');
    await symlink(join(parent, 'secret.txt'), join(cwd, 'link.txt'));
    await writeFile(join(cwd, 'inside.txt'), 'INSIDE_FIXTURE');
    const starts: string[] = [];
    const childModels: string[] = [];
    const childTools: string[][] = [];
    let mainTools: string[] = [];
    let startedIndependent!: () => void;
    const independent = new Promise<void>(resolve => { startedIndependent = resolve; });
    let calls = 0;
    let resolutions = 0;
    const modelRuntime = {
      getProviderProtocol: () => 'openai', getCapabilities: () => ({}), getMultimodal: () => undefined,
      async *stream(request: CanonicalModelRequest): AsyncGenerator<CanonicalModelEvent> {
        const first = request.messages.find(m => m.role === 'user')?.content[0];
        const text = first?.type === 'text' ? first.text : '';
        const isMain = text === 'parent';
        let toolCalls: Array<{ id: string; name: string; input: object }> = [];
        if (isMain && (++calls === 1 || (scenario === 'auto' && calls === 2))) {
          mainTools = request.tools?.map(t => t.name) ?? [];
          const tasks = scenario === 'duplicate' ? [task('a'), task('a')]
            : scenario === 'unknown' ? [task('a', ['missing'])]
            : scenario === 'self' ? [task('a', ['a'])]
            : scenario === 'empty' ? [{ ...task('a'), directive: '   ' }]
            : scenario === 'cycle' ? [task('a', ['b']), task('b', ['a'])]
            : scenario === 'disabled' ? [task('a'), task('b', [], 'disabled')]
            : scenario === 'dag' ? [task('after', ['b']), task('blocked', ['a']), task('a'), task('b')]
            : [task('scope')];
          toolCalls = [{ id: 'dispatch', name: 'delegate_project_tasks', input: { tasks } }];
          if (scenario === 'dag') toolCalls.unshift({ id: 'general', name: 'subagent', input: { description: 'should not run', prompt: 'unexpected' } });
        } else if (!isMain && !request.messages.some(m => m.content.some(b => b.type === 'tool_result'))) {
          const id = JSON.parse(text).task;
          starts.push(id);
          childModels.push(request.model);
          childTools.push(request.tools?.map(t => t.name) ?? []);
          if (id === 'a') {
            await independent;
            yield { type: 'error', error: { provider: request.provider, model: request.model, protocol: 'openai', code: 'model_not_found', message: 'fixture failed', retryable: false } };
            return;
          }
          if (id === 'b') startedIndependent();
          if (id === 'after') assert.match(text, /report from b/);
          if (id === 'scope') toolCalls = [
            { id: 'inside', name: 'read_file', input: { file_path: 'inside.txt' } },
            { id: 'escape', name: 'read_file', input: { file_path: '../secret.txt' } },
            { id: 'link', name: 'read_file', input: { file_path: 'link.txt' } },
            { id: 'write', name: 'write_file', input: { file_path: 'inside.txt', content: 'forbidden' } },
          ];
        }
        yield { type: 'message_start', role: 'assistant' };
        if (toolCalls.length) {
          for (const toolCall of toolCalls) yield { type: 'tool_call_end', toolCall };
        } else {
          const dump = JSON.stringify(request.messages);
          if (!isMain && scenario === 'scope') {
            assert.match(dump, /INSIDE_FIXTURE/);
            assert.doesNotMatch(dump, /OUTSIDE_SECRET/);
            assert.match(dump, /outside/i);
            assert.match(dump, /write_file does not exist/);
          }
          yield { type: 'text_delta', text: isMain ? 'parent summary' : `report from ${JSON.parse(text).task}` };
        }
        yield { type: 'message_end', finishReason: toolCalls.length ? 'tool_call' : 'stop' };
        yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } };
      },
    } as unknown as ModelRuntime;
    const router = createRouterRuntime({ scenarios: { default: { id: 'fixture/default', provider: 'fixture', model: 'default' } }, transientRetry: { enabled: false, maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 } }, { modelRuntime });
    if (scenario === 'auto') router.resolveProjectTaskModel = async () => { resolutions++; return { model: { provider: 'fixture', model: 'auto-small' }, difficulty: 'simple', reason: 'server judge simple' }; };
    const registry = scenario === 'noAuthority' ? new ToolRegistry() : createBuiltinRegistry({ webFetch: false, webSearch: false });
    if (scenario === 'noAuthority') registry.register(createAgentTool());
    const scheduler = new ConcurrentToolScheduler(new ToolRuntime(registry, new PermissionRuntime()), registry);
    const loop = new AgentLoop({ provider: 'fixture', model: 'default', cwd, permissionMode: 'bypassPermissions',
      permissionContext: { mode: 'bypassPermissions', rules: { allow: [], deny: [], ask: [] }, cwd,
        additionalWorkingDirectories: [parent], canPrompt: false, bypassAvailable: true },
    }, { router, tools: { registry, scheduler } });
    try {
      const events = [];
      for await (const event of loop.run({
        sessionId: 'session', turnId: 'turn', maxTurns: 3,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'parent' }] }],
        executionMode: scenario === 'solo' ? 'solo' : 'autoSplit',
        ...(scenario === 'auto' ? {} : { modelOverride: { provider: 'fixture', model: 'fixed' }, inheritModelOverride: true }),
        permissionRules: { allowList: [] },
        ...(scenario === 'noAuthority' ? {} : { projectTeamDispatch: {
          projectRoot: scenario === 'wrongRoot' ? parent : cwd,
          resolveMember: async (id: string) => id === 'worker' ? { id, briefing: 'Worker only', toolPolicy: { allow: ['read_file', 'bash'], deny: ['write_file'] } } : undefined,
          members: [{ id: 'worker', briefing: 'Worker only', toolPolicy: { allow: ['read_file', 'bash'], deny: ['write_file'] },
            model: { provider: 'fixture', model: 'member' } }],
        } }),
      })) events.push(event);
      const results = events.flatMap(e => e.type === 'tool_result' ? [e.result] : []);
      const dispatch = results.find(r => r.toolCallId === 'dispatch');
      if (scenario === 'dag') {
        assert.deepEqual(mainTools, ['delegate_project_tasks']);
        assert.equal(results.find(r => r.toolCallId === 'general')?.type, 'error');
        assert.deepEqual(starts.slice(0, 2).sort(), ['a', 'b'], JSON.stringify(dispatch));
        assert.equal(starts[2], 'after');
        assert.deepEqual(childModels, ['fixed', 'fixed', 'fixed']);
        assert.equal(dispatch?.type, 'success');
        assert.deepEqual((dispatch?.type === 'success' ? dispatch.data as { tasks: Array<{ id: string; status: string }> } : undefined)?.tasks.map(r => [r.id, r.status]),
          [['after', 'completed'], ['blocked', 'blocked'], ['a', 'failed'], ['b', 'completed']]);
      } else if (scenario === 'auto') {
        assert.deepEqual(childModels, ['auto-small', 'auto-small']);
        assert.equal(resolutions, 1);
        assert.match(JSON.stringify(dispatch), /server judge simple/);
        assert.match(JSON.stringify(dispatch), /resolvedModel/);
      } else if (scenario === 'scope') {
        assert.deepEqual(childTools, [['read_file']], JSON.stringify(dispatch));
        assert.equal(dispatch?.type, 'success');
        assert.match(JSON.stringify(dispatch), /report from scope/);
      } else {
        assert.ok(!mainTools.includes('delegate_project_tasks') || ['cycle', 'disabled', 'duplicate', 'unknown', 'self', 'empty'].includes(scenario));
        assert.equal(dispatch?.type, 'error');
        assert.deepEqual(starts, []);
        if (scenario === 'cycle' || scenario === 'disabled') assert.match(JSON.stringify(dispatch), scenario === 'cycle' ? /cycle/i : /unavailable/i);
      }
    } finally {
      startedIndependent();
      await router.shutdown();
      await rm(parent, { recursive: true, force: true });
    }
  });
}


for (const change of ['disabled', 'revoked', 'role', 'wrong-project', 'commander-revoked'] as const) {
  test(`team queued authority is refreshed after gate acquisition: ${change}`, async () => {
    const cwd = await mkdtemp(join(process.env.WORKSPACES_ROOT!, 'refresh-'));
    const gate = createSubagentGate(1);
    const { acquireSubagentSlot } = await import('./subagentConcurrency.js');
    const held = await acquireSubagentSlot(gate, {});
    // Runtime modules are shipped JavaScript without TypeScript declarations.
    const runtimeModule: string = '../../../ui/server/services/projectTeamRuntime.js';
    const configModule: string = '../../../ui/server/services/projectTeamConfig.js';
    const { resolveProjectTaskAuthority } = await import(runtimeModule);
    const { writeProjectTeamConfig } = await import(configModule);
    const permissions = { toolAccess: 'all', allowedTools: [], deniedTools: [], network: 'none', writeScope: 'project', requireApproval: false };
    const commander = { id: 'command', name: 'Command', description: '', roleDefinition: '', model: null, role: 'commander', enabled: true, permissions };
    const worker = { ...commander, id: 'worker', name: 'Worker', role: 'executor' };
    let registered = true;
    const snapshotProvider = async () => registered ? [{ fullPath: cwd }] : [];
    const save = (revision: string, agents: object[]) => writeProjectTeamConfig({ projectRoot: cwd, revision, collaboration: { mode: 'commander' }, agents, snapshotProvider });
    try {
      const initial = await save('0', [commander, worker]);
      const team: ProjectTeamDispatch = await resolveProjectTaskAuthority({ projectKey: cwd, sessionKey: 'queued', snapshotProvider });
      const executed: string[] = [];
      const result = dispatchProjectTasks([task('queued'), task('dependent', ['queued'])], team, gate, undefined, async (task, member) => {
        executed.push(task.id);
        if (change === 'role') {
          assert.deepEqual(member.toolPolicy.allow, ['read_file', 'grep', 'glob']);
          assert.ok(member.toolPolicy.deny?.includes('write_file'));
          assert.match(member.briefing, /read-only/);
        }
        return { report: 'fresh permissions' };
      });
      // Dependency scheduling yields before acquiring the occupied slot.
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(gate.pending(), 1);
      if (change === 'wrong-project') registered = false;
      else await save(initial.revision, [
        change === 'commander-revoked' ? { ...commander, enabled: false } : commander,
        change === 'disabled' ? { ...worker, enabled: false }
          : change === 'revoked' ? { ...worker, permissions: { ...permissions, toolAccess: 'allow-list', allowedTools: [] } }
          : change === 'role' ? { ...worker, role: 'inspector' } : worker,
      ]);
      held?.release();
      const results = await result;
      assert.deepEqual(results.map(result => result.status), change === 'role' ? ['completed', 'completed'] : ['failed', 'blocked']);
      assert.deepEqual(executed, change === 'role' ? ['queued', 'dependent'] : []);
      if (results[1].status === 'blocked') assert.deepEqual(results[1].blockedBy, ['queued']);
      assert.equal(gate.running(), 0);
    } finally {
      held?.release();
      await rm(cwd, { recursive: true, force: true });
    }
  });
}

test('team DAG respects shared gate and drains cancelled queued work', async () => {
  const gate = createSubagentGate(2);
  const controller = new AbortController();
  let running = 0;
  let peak = 0;
  let started = 0;
  let release!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  const result = dispatchProjectTasks([task('a'), task('b'), task('c')], {
    projectRoot: '.', members: [{ id: 'worker', briefing: '', toolPolicy: {} }],
    resolveMember: async id => ({ id, briefing: '', toolPolicy: {} }),
  }, gate, controller.signal, async () => {
    started++;
    peak = Math.max(peak, ++running);
    if (started === 2) { controller.abort(); release(); }
    await hold;
    running--;
    return { report: 'done' };
  });
  const results = await result;
  assert.equal(peak, 2);
  assert.equal(started, 2);
  assert.deepEqual(results.map(r => r.status), ['failed', 'failed', 'failed']);
  assert.equal(gate.running(), 0);
  assert.equal(gate.pending(), 0);
});
