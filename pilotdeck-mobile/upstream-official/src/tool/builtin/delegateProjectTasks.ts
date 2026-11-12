import { PilotDeckToolRuntimeError } from '../protocol/errors.js';
import type { PilotDeckToolDefinition } from '../protocol/types.js';

export const PROJECT_TASK_TOOL = 'delegate_project_tasks';
export type ProjectTask = { id: string; memberId: string; directive: string; dependsOn: string[] };

const idSchema = { type: 'string', pattern: '^[A-Za-z0-9._-]{1,64}$' };
export function createDelegateProjectTasksTool(): PilotDeckToolDefinition<{ tasks: ProjectTask[] }> {
  return {
    name: PROJECT_TASK_TOOL,
    kind: 'agent',
    description: 'Delegate a batch of independent or dependent tasks to the listed project members, then summarize their results. Include only the context needed for each task.',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['tasks'],
      properties: { tasks: { type: 'array', minItems: 1, maxItems: 8, items: {
        type: 'object', additionalProperties: false, required: ['id', 'memberId', 'directive', 'dependsOn'],
        properties: { id: idSchema, memberId: idSchema, directive: { type: 'string', minLength: 1, maxLength: 4000 },
          dependsOn: { type: 'array', maxItems: 7, items: idSchema } },
      } } },
    },
    // Delegated members may now write files and run commands; a delegated
    // batch is no longer a read-only inspection.
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    async execute({ tasks }, context) {
      if (!context.delegateProjectTasks || context.delegationDisabled) {
        throw new PilotDeckToolRuntimeError('permission_denied', 'Project delegation is unavailable.');
      }
      const data = { tasks: await context.delegateProjectTasks(tasks, context.abortSignal) };
      return { data, content: [{ type: 'json', value: data }] };
    },
  };
}
