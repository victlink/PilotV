import { realpathSync } from 'node:fs';
import type { AgentModelOverride } from '../protocol/input.js';
import type { ProjectTask } from '../../tool/builtin/delegateProjectTasks.js';
import { PilotDeckToolRuntimeError } from '../../tool/protocol/errors.js';
import { acquireSubagentSlot, type SubagentGate } from './subagentConcurrency.js';

export type ProjectTeamDispatch = {
  projectRoot: string;
  members: ProjectTaskMember[];
  /** Server-owned resolver; invoked only after dependency and concurrency waits. */
  resolveMember: (memberId: string) => Promise<ProjectTaskMember | undefined>;
};
export type ProjectTaskMember = {
  id: string;
  briefing: string;
  toolPolicy: { allow?: string[]; deny?: string[]; ask?: string[]; writeRoots?: string[] };
  model?: AgentModelOverride;
};
export type ProjectTaskModelRecord = { resolvedModel?: AgentModelOverride; difficulty?: string; selectionReason?: string };
export type ProjectTaskResult = ProjectTaskModelRecord & {
  id: string;
  memberId: string;
} & ({ status: 'completed'; report: string; model?: AgentModelOverride }
  | { status: 'failed'; error: string }
  | { status: 'blocked'; blockedBy: string[] });

export function sameProjectRoot(left: string, right: string): boolean {
  try { return realpathSync(left) === realpathSync(right); } catch { return false; }
}

export async function dispatchProjectTasks(
  tasks: ProjectTask[],
  team: ProjectTeamDispatch,
  gate: SubagentGate | undefined,
  signal: AbortSignal | undefined,
  execute: (task: ProjectTask, member: ProjectTaskMember, dependencies: ProjectTaskResult[], recordModel: (record: ProjectTaskModelRecord) => void) => Promise<{ report: string; model?: AgentModelOverride } & ProjectTaskModelRecord>,
): Promise<ProjectTaskResult[]> {
  const reject = (message: string): never => { throw new PilotDeckToolRuntimeError('invalid_tool_input', message); };
  const byId = new Map(tasks.map(task => [task.id, task]));
  const members = new Map(team.members.map(member => [member.id, member]));
  if (byId.size !== tasks.length) reject('Duplicate task id.');
  for (const task of tasks) {
    if (!task.directive.trim()) reject(`Task ${task.id} has an empty directive.`);
    if (!members.has(task.memberId)) reject(`Member unavailable: ${task.memberId}.`);
    if (new Set(task.dependsOn).size !== task.dependsOn.length) reject(`Duplicate dependency for ${task.id}.`);
    for (const dependency of task.dependsOn) if (!byId.has(dependency)) reject(`Unknown dependency: ${dependency}.`);
  }
  const checked = new Set<string>();
  const active = new Set<string>();
  function visit(id: string) {
    if (active.has(id)) reject(`Dependency cycle at ${id}.`);
    if (checked.has(id)) return;
    active.add(id);
    for (const dependency of byId.get(id)!.dependsOn) visit(dependency);
    active.delete(id);
    checked.add(id);
  }
  for (const task of tasks) visit(task.id);

  const runs = new Map<string, Promise<ProjectTaskResult>>();
  function run(task: ProjectTask): Promise<ProjectTaskResult> {
    const existing = runs.get(task.id);
    if (existing) return existing;
    const pending = (async (): Promise<ProjectTaskResult> => {
      const base: { id: string; memberId: string } & ProjectTaskModelRecord = { id: task.id, memberId: task.memberId };
      const dependencies = await Promise.all(task.dependsOn.map(id => run(byId.get(id)!)));
      const blockedBy = dependencies.filter(result => result.status !== 'completed').map(result => result.id);
      if (blockedBy.length) return { ...base, status: 'blocked', blockedBy };
      try {
        signal?.throwIfAborted();
        const slot = await acquireSubagentSlot(gate, { signal });
        try {
          signal?.throwIfAborted();
          const member = await team.resolveMember(task.memberId);
          signal?.throwIfAborted();
          if (!member || member.id !== task.memberId) throw new Error(`Member unavailable: ${task.memberId}.`);
          // This narrow executor can only inspect files. No remaining readable
          // capability means authorization was revoked, not a successful no-op.
          const readable = ['read_file', 'grep', 'glob'].some(tool =>
            (member.toolPolicy.allow === undefined || member.toolPolicy.allow.includes(tool))
            && !member.toolPolicy.deny?.includes(tool));
          if (!readable) throw new Error(`Member permissions revoked: ${task.memberId}.`);
          const result = await execute(task, member, dependencies, record => Object.assign(base, record));
          signal?.throwIfAborted();
          return { ...base, status: 'completed', ...result };
        } finally { slot?.release(); }
      } catch (error) {
        return { ...base, status: 'failed', error: signal?.aborted ? 'Cancelled.' : (error instanceof Error ? error.message.slice(0, 500) : 'Task failed.') };
      }
    })();
    runs.set(task.id, pending);
    return pending;
  }
  return Promise.all(tasks.map(run));
}
