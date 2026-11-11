import { useTranslation } from "react-i18next";
import { FormRow, Select } from "../../../shared/components/Inputs";
import { SettingsCard, SettingsToggle } from "../../../shared/view";
import {
  PROJECT_TEAM_NETWORK_MODES,
  PROJECT_TEAM_TOOL_ACCESS_MODES,
  PROJECT_TEAM_WRITE_SCOPES,
  type ProjectAgentPermissions,
  type ProjectNetworkMode,
  type ProjectToolAccessMode,
  type ProjectWriteScope,
} from "../../../../../lib/projectTeam";
import type { AgentPanelProps } from "../types";
import AgentPicker from "./AgentPicker";
import EmptyPanel from "./EmptyPanel";
import ToolEntryEditor from "./ToolEntryEditor";

export default function ToolsPanel({
  agents,
  selectedAgentId,
  onSelectAgent,
  onChangeAgent,
}: AgentPanelProps) {
  const { t } = useTranslation("projectTeam");
  const agent = agents.find((item) => item.id === selectedAgentId) ?? null;

  if (!agent) {
    return <EmptyPanel message={t("tools.selectAgent")} />;
  }

  const permissions = agent.permissions;

  const patchPermissions = (patch: Partial<ProjectAgentPermissions>) => {
    onChangeAgent(agent.id, {
      permissions: { ...permissions, ...patch },
    });
  };

  return (
    <div className="flex flex-col gap-3">
      <AgentPicker
        agents={agents}
        selectedAgentId={selectedAgentId}
        onSelectAgent={onSelectAgent}
      />

      {["commander", "reviewer", "inspector"].includes(agent.role) && (
        <p className="text-[13px] text-muted-foreground">{t("templates.restricted")}</p>
      )}
      <SettingsCard divided>
        <FormRow label={t("tools.toolAccess")} description={t("tools.toolAccessHint")}>
          <Select
            value={permissions.toolAccess}
            onChange={(next) =>
              patchPermissions({
                toolAccess: next as ProjectToolAccessMode,
              })
            }
            options={PROJECT_TEAM_TOOL_ACCESS_MODES.map((mode) => ({
              value: mode,
              label: t(`tools.accessModes.${mode}`),
            }))}
          />
        </FormRow>

        {permissions.toolAccess === "allow-list" ? (
          <FormRow
            label={t("tools.allowList")}
            description={t("tools.allowListHint")}
          >
            <ToolEntryEditor
              listLabel={t("tools.allowList")}
              entries={permissions.allowedTools}
              onChange={(allowedTools) => patchPermissions({ allowedTools })}
            />
          </FormRow>
        ) : null}

        <FormRow label={t("tools.denyList")} description={t("tools.denyListHint")}>
          <ToolEntryEditor
            listLabel={t("tools.denyList")}
            entries={permissions.deniedTools}
            onChange={(deniedTools) => patchPermissions({ deniedTools })}
          />
        </FormRow>

        <FormRow label={t("tools.network")} description={t("tools.networkHint")}>
          <Select
            value={permissions.network}
            onChange={(next) =>
              patchPermissions({ network: next as ProjectNetworkMode })
            }
            options={PROJECT_TEAM_NETWORK_MODES.map((mode) => ({
              value: mode,
              label: t(`tools.networkModes.${mode}`),
            }))}
          />
        </FormRow>

        <FormRow label={t("tools.writeScope")} description={t("tools.writeScopeHint")}>
          <Select
            value={permissions.writeScope}
            onChange={(next) =>
              patchPermissions({ writeScope: next as ProjectWriteScope })
            }
            options={PROJECT_TEAM_WRITE_SCOPES.map((scope) => ({
              value: scope,
              label: t(`tools.writeScopes.${scope}`),
            }))}
          />
        </FormRow>

        <FormRow
          label={t("tools.requireApproval")}
          description={t("tools.requireApprovalHint")}
        >
          <SettingsToggle
            checked={permissions.requireApproval}
            showSuccessToast={false}
            ariaLabel={t("tools.requireApproval")}
            onChange={(requireApproval) =>
              patchPermissions({ requireApproval })
            }
          />
        </FormRow>
      </SettingsCard>
    </div>
  );
}
