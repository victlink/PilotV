import { useTranslation } from "react-i18next";
import { FormRow, Select } from "../../../shared/components/Inputs";
import { SettingsCard } from "../../../shared/view";
import {
  PROJECT_TEAM_COLLABORATION_MODES,
  type ProjectCollaborationMode,
} from "../../../../../lib/projectTeam";
import type { CollaborationPanelProps } from "../types";

export default function CollaborationPanel({
  agents,
  collaboration,
  onChangeCollaboration,
  onChangeAgent,
}: CollaborationPanelProps) {
  const { t } = useTranslation("projectTeam");

  return (
    <div className="flex flex-col gap-3">
      <SettingsCard divided>
        <FormRow
          label={t("collaboration.mode")}
          description={t("collaboration.modeHint")}
        >
          <Select
            value={collaboration.mode}
            onChange={(next) =>
              onChangeCollaboration({
                mode: next as ProjectCollaborationMode,
              })
            }
            options={PROJECT_TEAM_COLLABORATION_MODES.map((mode) => ({
              value: mode,
              label: t(`collaboration.modes.${mode}`),
            }))}
          />
        </FormRow>
      </SettingsCard>

      <SettingsCard divided>
        {agents.length === 0 ? (
          <div className="px-4 py-6 text-center text-[13px] text-muted-foreground">
            {t("collaboration.empty")}
          </div>
        ) : (
          agents.map((agent) => (
            <FormRow
              key={agent.id}
              label={agent.name}
              description={t("collaboration.reportsToHint")}
            >
              <Select
                value={agent.reportsTo ?? ""}
                onChange={(next) =>
                  onChangeAgent(agent.id, { reportsTo: next || null })
                }
                options={[
                  { value: "", label: t("collaboration.reportsToNone") },
                  ...agents
                    .filter((item) => item.id !== agent.id)
                    .map((item) => ({
                      value: item.id,
                      label: item.name,
                    })),
                ]}
              />
            </FormRow>
          ))
        )}
      </SettingsCard>
    </div>
  );
}
