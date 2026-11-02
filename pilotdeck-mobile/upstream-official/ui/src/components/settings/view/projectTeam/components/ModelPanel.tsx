import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import {
  FormRow,
  Select,
} from "../../../shared/components/Inputs";
import { usePilotDeckConfig } from "../../../../../hooks/usePilotDeckConfig";
import { safeParseYaml } from "../../modelPool/utils/configYaml";
import { buildModelRefOptions, splitModelRef } from "../../modelPool/utils/modelRefs";
import { SettingsCard } from "../../../shared/view";
import AgentPicker from "./AgentPicker";
import EmptyPanel from "./EmptyPanel";
import type { AgentPanelProps } from "../types";

const FOLLOW_SESSION = "follow-session";
const CUSTOM_MODEL = "custom-model";

export default function ModelPanel({
  agents,
  selectedAgentId,
  onSelectAgent,
  onChangeAgent,
}: AgentPanelProps) {
  const { t } = useTranslation("projectTeam");
  const { raw, loading: configLoading } = usePilotDeckConfig();
  const modelOptions = useMemo(() => {
    const config = safeParseYaml(raw);
    return config ? buildModelRefOptions(config) : [];
  }, [raw]);
  const agent = agents.find((item) => item.id === selectedAgentId) ?? null;

  if (!agent) {
    return <EmptyPanel message={t("model.selectAgent")} />;
  }

  const mode = agent.model ? CUSTOM_MODEL : FOLLOW_SESSION;

  return (
    <div className="flex flex-col gap-3">
      <AgentPicker
        agents={agents}
        selectedAgentId={selectedAgentId}
        onSelectAgent={onSelectAgent}
      />

      <SettingsCard divided>
        <FormRow label={t("model.source")} description={t("model.sourceHint")}>
          <Select
            value={mode}
            onChange={(next) =>
              onChangeAgent(agent.id, {
                model:
                  next === CUSTOM_MODEL
                    ? agent.model ?? { provider: "", model: "" }
                    : null,
              })
            }
            options={[
              { value: FOLLOW_SESSION, label: t("model.followSession") },
              { value: CUSTOM_MODEL, label: t("model.custom") },
            ]}
          />
        </FormRow>

        {agent.model ? (
          <FormRow label={t("model.model")} description={t("model.libraryHint")}>
            <Select
              value={`${agent.model.provider}/${agent.model.model}`}
              disabled={configLoading || modelOptions.length === 0}
              options={modelOptions.length > 0
                ? [{ value: "/", label: t("model.model") }, ...modelOptions]
                : [{ value: `${agent.model.provider}/${agent.model.model}`, label: t("model.libraryEmpty") }]}
              onChange={(next) => {
                const parsed = splitModelRef(next);
                if (parsed) onChangeAgent(agent.id, {
                  model: { provider: parsed.providerId, model: parsed.modelId },
                });
              }}
            />
          </FormRow>
        ) : null}
      </SettingsCard>
    </div>
  );
}
