import { useTranslation } from "react-i18next";
import { FormRow, Select } from "../../../shared/components/Inputs";
import { SettingsCard } from "../../../shared/view";
import {
  PROJECT_TEAM_MAX_DESCRIPTION_LENGTH,
  PROJECT_TEAM_MAX_NAME_LENGTH,
  PROJECT_TEAM_MAX_ROLE_DEFINITION_LENGTH,
  PROJECT_TEAM_ROLES,
  type ProjectAgentRole,
} from "../../../../../lib/projectTeam";
import { getDefaultAgentTemplate, roleLabelKey } from "../roleLabels";
import { resolveProjectTeamLocale } from "../validationMessages";
import type { AgentPanelProps } from "../types";
import AgentPicker from "./AgentPicker";
import EmptyPanel from "./EmptyPanel";

const INPUT_CLASS =
  "w-full rounded-md border border-border bg-background px-2 py-1.5 text-[13px] leading-5 text-foreground outline-none focus:ring-1 focus:ring-ring";
const TEXTAREA_CLASS = `${INPUT_CLASS} min-h-[96px] resize-y font-mono text-xs leading-5`;

/**
 * 带长度上限的输入框。
 *
 * 共享的 `TextInput` / `TextAreaInput` 不透传 `maxLength`，而这里必须把上限
 * 交给浏览器强制执行（后端对超长值一律 400）。所以本分区自己渲染原生控件。
 */
function LimitedTextInput({
  value,
  onChange,
  placeholder,
  maxLength,
}: {
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  maxLength: number;
}) {
  return (
    <input
      type="text"
      value={value}
      maxLength={maxLength}
      placeholder={placeholder}
      spellCheck={false}
      onChange={(event) => onChange(event.target.value)}
      className={INPUT_CLASS}
    />
  );
}

function LimitedTextArea({
  value,
  onChange,
  placeholder,
  maxLength,
}: {
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  maxLength: number;
}) {
  return (
    <textarea
      value={value}
      maxLength={maxLength}
      placeholder={placeholder}
      spellCheck={false}
      onChange={(event) => onChange(event.target.value)}
      className={TEXTAREA_CLASS}
    />
  );
}

export default function RolePanel({
  agents,
  selectedAgentId,
  onSelectAgent,
  onChangeAgent,
}: AgentPanelProps) {
  const { t, i18n } = useTranslation("projectTeam");
  const locale = resolveProjectTeamLocale(i18n?.language);
  const agent = agents.find((item) => item.id === selectedAgentId) ?? null;

  if (!agent) {
    return <EmptyPanel message={t("roles.selectAgent")} />;
  }

  const roleOptions = PROJECT_TEAM_ROLES.map((role) => ({
    value: role,
    label: t(roleLabelKey(role)),
  }));

  const handleRoleChange = (next: string) => {
    const role = next as ProjectAgentRole;
    const previousTemplate = getDefaultAgentTemplate(agent.role, locale);
    const nextTemplate = getDefaultAgentTemplate(role, locale);
    // 用户没有改过职责/定义时，切换角色顺带套用新模板。
    const untouched =
      agent.description === previousTemplate.description &&
      agent.roleDefinition === previousTemplate.roleDefinition;

    onChangeAgent(agent.id, {
      role,
      ...(untouched
        ? {
            description: nextTemplate.description,
            roleDefinition: nextTemplate.roleDefinition,
          }
        : {}),
    });
  };

  return (
    <div className="flex flex-col gap-3">
      <AgentPicker
        agents={agents}
        selectedAgentId={selectedAgentId}
        onSelectAgent={onSelectAgent}
      />

      <SettingsCard divided>
        <FormRow label={t("roles.name")} description={t("roles.nameHint")}>
          <LimitedTextInput
            value={agent.name}
            maxLength={PROJECT_TEAM_MAX_NAME_LENGTH}
            placeholder={t("roles.namePlaceholder")}
            onChange={(next) => onChangeAgent(agent.id, { name: next })}
          />
        </FormRow>

        <FormRow label={t("roles.role")} description={t("roles.roleHint")}>
          <Select
            value={agent.role}
            onChange={handleRoleChange}
            options={roleOptions}
          />
        </FormRow>

        <FormRow
          label={t("roles.duty")}
          description={t("roles.dutyHint")}
        >
          <LimitedTextArea
            value={agent.description}
            maxLength={PROJECT_TEAM_MAX_DESCRIPTION_LENGTH}
            placeholder={t("roles.dutyPlaceholder")}
            onChange={(next) => onChangeAgent(agent.id, { description: next })}
          />
        </FormRow>

        <FormRow
          label={t("roles.definition")}
          description={t("roles.definitionHint")}
        >
          <LimitedTextArea
            value={agent.roleDefinition}
            maxLength={PROJECT_TEAM_MAX_ROLE_DEFINITION_LENGTH}
            placeholder={t("roles.definitionPlaceholder")}
            onChange={(next) =>
              onChangeAgent(agent.id, { roleDefinition: next })
            }
          />
        </FormRow>
      </SettingsCard>
    </div>
  );
}
