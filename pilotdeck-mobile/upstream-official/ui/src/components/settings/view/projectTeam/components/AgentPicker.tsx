import { useTranslation } from "react-i18next";
import { Select } from "../../../shared/components/Inputs";
import type { ProjectTeamAgent } from "../../../../../lib/projectTeam";

type AgentPickerProps = {
  agents: ProjectTeamAgent[];
  selectedAgentId: string | null;
  onSelectAgent: (agentId: string) => void;
};

export default function AgentPicker({
  agents,
  selectedAgentId,
  onSelectAgent,
}: AgentPickerProps) {
  const { t } = useTranslation("projectTeam");

  if (agents.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-[12px] text-muted-foreground">{t("common.agent")}</span>
      <div className="min-w-[180px] flex-1 sm:max-w-[280px]">
        <Select
          value={selectedAgentId ?? ""}
          onChange={(next) => onSelectAgent(next)}
          options={agents.map((agent) => ({
            value: agent.id,
            label: agent.name,
          }))}
        />
      </div>
    </div>
  );
}
