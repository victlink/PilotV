import { Bot, Code2, Crown, Eye, ShieldCheck } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { ProjectTeamAgent } from '../../lib/projectTeam';

const roleIcons = { commander: Crown, reviewer: Eye, executor: Code2, supervisor: ShieldCheck };

/** Team availability is not evidence that an agent has executed a turn. */
export default function ProjectTeamStrip({ agents, selectedAgentId, onSelect, participants = [] }: {
  agents: ProjectTeamAgent[];
  participants?: Array<{agentId: string; name: string; role: string}>;
  selectedAgentId: string | null;
  onSelect: (id: string | null) => void;
}) {
  const { i18n } = useTranslation('chat');
  const zh = i18n?.language?.startsWith('zh') ?? true;
  if (!agents.length && !participants.length) return null;
  return (
    <div className="z-10 flex shrink-0 justify-center px-3 py-2" data-testid="project-team-strip">
      <div className="flex max-w-full items-center gap-1 overflow-x-auto rounded-full border border-neutral-200 bg-white/90 p-1 shadow-sm backdrop-blur dark:border-neutral-700 dark:bg-neutral-900/90" aria-label={zh ? '项目团队' : 'Project team'}>
        <span className="shrink-0 px-2 text-xs text-neutral-500">{zh ? '项目团队' : 'Project team'}</span>
        {participants.length > 0 && <span className="shrink-0 px-2 text-xs text-emerald-700 dark:text-emerald-400" data-testid="task-participants">{zh ? '已参与：' : 'Participated: '}{participants.map((p) => p.name).join(' · ')}</span>}
        {[{ id: null, name: zh ? '默认 Agent' : 'Default agent', role: '' }, ...agents].map((agent) => {
          const Icon = roleIcons[agent.role as keyof typeof roleIcons] || Bot;
          const selected = agent.id === selectedAgentId;
          return <button key={agent.id || 'default'} type="button" aria-pressed={selected}
            aria-label={agent.name} onClick={() => onSelect(agent.id)}
            title={zh ? (selected ? '后续任务使用此 Agent' : '可用成员，点击用于后续任务') : (selected ? 'Agent for next task' : 'Available for next task')}
            className={`inline-flex min-h-9 shrink-0 items-center gap-1.5 rounded-full px-3 text-xs transition-colors ${selected ? 'bg-neutral-900 text-white dark:bg-white dark:text-neutral-900' : 'text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800'}`}>
            <Icon className="h-4 w-4" aria-hidden="true" /><span>{agent.name}</span>
          </button>;
        })}
      </div>
    </div>
  );
}
