import { useTranslation } from "react-i18next";
import { Pencil, Trash2 } from "lucide-react";
import { SettingsToggle } from "../../../shared/view";
import { cn } from "../../../../../lib/utils";
import { roleLabelKey } from "../roleLabels";
import type { AgentPanelProps } from "../types";

type MembersPanelProps = AgentPanelProps & {
  onAddAgent: () => void;
  onEditAgent: (agentId: string) => void;
  onRequestRemove: (agentId: string) => void;
};

function modelSummary(
  model: { provider: string; model: string } | null,
  fallback: string,
): string {
  if (!model) return fallback;
  const provider = model.provider.trim();
  const name = model.model.trim();
  if (provider && name) return `${provider}/${name}`;
  return provider || name || fallback;
}

export default function MembersPanel({
  agents,
  selectedAgentId,
  onAddAgent,
  onEditAgent,
  onRequestRemove,
  onChangeAgent,
}: MembersPanelProps) {
  const { t } = useTranslation("projectTeam");

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[13px] text-muted-foreground">{t("members.hint")}</p>
        <button
          type="button"
          onClick={onAddAgent}
          className="inline-flex h-8 items-center gap-1.5 rounded-md bg-[var(--pd-accent,#5b5ce2)] px-3 text-[13px] font-medium text-white transition-colors enabled:hover:bg-[var(--pd-accent-strong,#4948cf)]"
        >
          {t("actions.addAgent")}
        </button>
      </div>

      {agents.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border bg-muted/20 px-4 py-8 text-center text-[13px] text-muted-foreground">
          {t("members.empty")}
        </div>
      ) : (
        <ul className="flex flex-col gap-2">
          {agents.map((agent) => {
            const active = agent.id === selectedAgentId;
            return (
              <li
                key={agent.id}
                className={cn(
                  "flex flex-wrap items-center gap-3 rounded-xl border bg-card/50 px-4 py-3",
                  active ? "border-[var(--pd-accent,#5b5ce2)]" : "border-border",
                )}
              >
                <button
                  type="button"
                  onClick={() => onEditAgent(agent.id)}
                  className="flex min-w-0 flex-1 flex-col items-start gap-0.5 text-left"
                >
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="truncate text-sm font-medium text-foreground">
                      {agent.name}
                    </span>
                    <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
                      {t(roleLabelKey(agent.role))}
                    </span>
                    {agent.enabled ? null : (
                      <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
                        {t("members.disabled")}
                      </span>
                    )}
                  </span>
                  <span className="truncate text-[12px] text-muted-foreground">
                    {t("members.modelSummary", {
                      model: modelSummary(
                        agent.model,
                        t("members.modelFollowSession"),
                      ),
                    })}
                  </span>
                </button>

                <SettingsToggle
                  checked={agent.enabled}
                  showSuccessToast={false}
                  ariaLabel={t("members.enabled", { name: agent.name })}
                  onChange={(enabled) =>
                    onChangeAgent(agent.id, { enabled })
                  }
                />

                <button
                  type="button"
                  aria-label={t("actions.editAgent", { name: agent.name })}
                  title={t("actions.editAgent", { name: agent.name })}
                  onClick={() => onEditAgent(agent.id)}
                  className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                >
                  <Pencil size={15} />
                </button>

                <button
                  type="button"
                  aria-label={t("actions.removeAgent", { name: agent.name })}
                  title={t("actions.removeAgent", { name: agent.name })}
                  onClick={() => onRequestRemove(agent.id)}
                  className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                >
                  <Trash2 size={15} />
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
