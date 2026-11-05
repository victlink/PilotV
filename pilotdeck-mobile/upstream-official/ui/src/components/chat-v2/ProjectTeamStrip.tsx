import { useTranslation } from 'react-i18next';
import { TEAM_ICON, type SpeakerEntry } from './agentIdentity';

/**
 * 对话栏上方的发言人条。
 *
 * 它现在是一排「发言人筛选器」：默认停在「团队」（显示全部发言人），
 * 点某个成员就只看这个成员的发言，再点一次回到全部。
 * 成员的名字按角色显示（指挥 / 主agent / 审查 …），具体是谁放在 title 里。
 */
export default function ProjectTeamStrip({
  speakers,
  activeSpeakerKey,
  onSelectSpeaker,
}: {
  speakers: SpeakerEntry[];
  activeSpeakerKey: string | null;
  onSelectSpeaker: (key: string | null) => void;
}) {
  const { t } = useTranslation('chat');
  if (!speakers.length) return null;

  const teamLabel = t('speaker.team', { defaultValue: '团队' });
  const mainAgentLabel = t('speaker.mainAgent', { defaultValue: '主agent' });
  const showAllLabel = t('speaker.showAll', { defaultValue: '显示全部发言人' });
  const filterLabel = t('speaker.onlyThis', { defaultValue: '只看 {{name}}' });

  const labelFor = (speaker: SpeakerEntry): string => {
    if (speaker.identity.roleLabelKey) {
      const roleLabel = String(t(speaker.identity.roleLabelKey, { defaultValue: '' }));
      if (roleLabel && roleLabel !== speaker.identity.roleLabelKey) return roleLabel;
    }
    if (!speaker.name) return mainAgentLabel;
    return speaker.name;
  };

  const TeamIcon = TEAM_ICON;
  const teamActive = !activeSpeakerKey;

  return (
    <div className="z-10 flex shrink-0 justify-center px-3 py-2" data-testid="project-team-strip">
      <div
        className="flex max-w-full items-center gap-1 overflow-x-auto rounded-full border border-neutral-200 bg-white/90 p-1 shadow-sm backdrop-blur dark:border-neutral-700 dark:bg-neutral-900/90"
        aria-label={teamLabel}
        role="group"
      >
        <button
          type="button"
          data-testid="speaker-filter-team"
          aria-pressed={teamActive}
          onClick={() => onSelectSpeaker(null)}
          title={showAllLabel}
          className={`inline-flex min-h-9 shrink-0 items-center gap-1.5 rounded-full px-3 text-xs transition-colors ${
            teamActive
              ? 'bg-neutral-900 text-white dark:bg-white dark:text-neutral-900'
              : 'text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800'
          }`}
        >
          <TeamIcon className="h-4 w-4" aria-hidden="true" />
          <span>{teamLabel}</span>
        </button>
        {speakers.map((speaker) => {
          const label = labelFor(speaker);
          const active = activeSpeakerKey === speaker.identity.key;
          const Icon = speaker.identity.Icon;
          const title = speaker.name && speaker.name !== label ? `${label} · ${speaker.name}` : label;
          return (
            <button
              key={speaker.identity.key}
              type="button"
              data-testid="speaker-filter-item"
              data-speaker-key={speaker.identity.key}
              aria-pressed={active}
              onClick={() => onSelectSpeaker(active ? null : speaker.identity.key)}
              title={filterLabel.replace('{{name}}', title)}
              aria-label={speaker.name && speaker.name !== label ? `${label} ${speaker.name}` : label}
              className={`inline-flex min-h-9 shrink-0 items-center gap-1.5 rounded-full border px-3 text-xs transition-colors ${
                active
                  ? `${speaker.identity.surfaceClass} ${speaker.identity.borderClass} ${speaker.identity.textClass}`
                  : `border-transparent text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800 ${speaker.identity.textClass}`
              }`}
            >
              <Icon className="h-4 w-4" aria-hidden="true" />
              <span className="truncate">{label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
