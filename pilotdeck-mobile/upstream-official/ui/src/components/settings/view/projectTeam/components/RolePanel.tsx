import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ConfirmDialog } from "../../../../ui/ConfirmDialog";
import { FormRow, Select } from "../../../shared/components/Inputs";
import { SettingsCard } from "../../../shared/view";
import {
  PROJECT_TEAM_MAX_DESCRIPTION_LENGTH,
  PROJECT_TEAM_MAX_NAME_LENGTH,
  PROJECT_TEAM_MAX_ROLE_DEFINITION_LENGTH,
  PROJECT_TEAM_ROLES,
  type ProjectAgentRole,
  type ProjectTeamAgent,
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

const TEMPLATE_STORAGE_KEY = "pilotdeck.projectTeam.roleTemplates.v1";
const TEMPLATE_ENTRY_PREFIX = "pilotdeck.projectTeam.roleTemplates.v2:";
const ACTION_CLASS = "rounded-md border border-border px-3 py-1.5 text-[13px] enabled:hover:bg-muted disabled:opacity-50";

const DEFAULT_SELECTION = "builtin:executor";

type Definition = Pick<ProjectTeamAgent, "description" | "roleDefinition">;
type Template = Definition & { role: ProjectAgentRole };
type SavedTemplate = Template & { id: string; name: string };

function readLegacyTemplates(): SavedTemplate[] {
  const value: unknown = JSON.parse(localStorage.getItem(TEMPLATE_STORAGE_KEY) ?? "[]");
  if (!Array.isArray(value)) return [];
  const legacyCounts = new Map<string, number>();
  return value.filter((item): item is Omit<SavedTemplate, "id"> & { id?: unknown } =>
    item && PROJECT_TEAM_ROLES.includes(item.role) &&
    typeof item.name === "string" && item.name.trim() && item.name.length <= PROJECT_TEAM_MAX_NAME_LENGTH &&
    typeof item.description === "string" && item.description.length <= PROJECT_TEAM_MAX_DESCRIPTION_LENGTH &&
    typeof item.roleDefinition === "string" && item.roleDefinition.length <= PROJECT_TEAM_MAX_ROLE_DEFINITION_LENGTH
  ).map(({ id, role, name, description, roleDefinition }) => {
    if (typeof id === "string" && id) return { id, role, name, description, roleDefinition };
    // Preserve existing copies without IDs, including identical copies, until the next save persists IDs.
    const content = JSON.stringify([role, name, description, roleDefinition]);
    const occurrence = (legacyCounts.get(content) ?? 0) + 1;
    legacyCounts.set(content, occurrence);
    return { id: `legacy:${occurrence}:${content}`, role, name, description, roleDefinition };
  });
}

function readSavedTemplates(): SavedTemplate[] {
  let legacy: SavedTemplate[] = [];
  try { legacy = readLegacyTemplates(); } catch { /* A corrupt legacy table must not hide new entries. */ }
  const templates = new Map(legacy.map((item) => [item.id, item]));
  for (let index = 0; index < localStorage.length; index++) {
    const key = localStorage.key(index);
    if (!key?.startsWith(TEMPLATE_ENTRY_PREFIX)) continue;
    try {
      const item = JSON.parse(localStorage.getItem(key) ?? "null");
      if (item && typeof item.id === "string" && key === TEMPLATE_ENTRY_PREFIX + item.id &&
        PROJECT_TEAM_ROLES.includes(item.role) && typeof item.name === "string" && item.name.trim() &&
        item.name.length <= PROJECT_TEAM_MAX_NAME_LENGTH && typeof item.description === "string" &&
        item.description.length <= PROJECT_TEAM_MAX_DESCRIPTION_LENGTH && typeof item.roleDefinition === "string" &&
        item.roleDefinition.length <= PROJECT_TEAM_MAX_ROLE_DEFINITION_LENGTH) templates.set(item.id, item);
    } catch { /* Ignore a malformed entry without hiding other templates. */ }
  }
  return [...templates.values()];
}

function loadSavedTemplates(): SavedTemplate[] {
  try {
    return readSavedTemplates();
  } catch {
    return [];
  }
}

function TemplateEditor({ onApply }: { onApply?: (definition: Definition) => void }) {
  const { t, i18n } = useTranslation("projectTeam");
  const locale = resolveProjectTeamLocale(i18n?.language);
  const [saved, setSaved] = useState(loadSavedTemplates);
  const [selection, setSelection] = useState(DEFAULT_SELECTION);
  const [edited, setEdited] = useState<Template | null>(null);
  const [name, setName] = useState("");
  const [saveFailed, setSaveFailed] = useState(false);
  const stored = selection.startsWith("saved:") ? saved.find(({ id }) => id === selection.slice(6)) : undefined;
  const role = stored?.role ?? (selection.startsWith("builtin:") ? selection.slice(8) as ProjectAgentRole : "executor");
  const builtin = { role, ...getDefaultAgentTemplate(role, locale) };
  const draft = edited ?? (stored ? { role, description: stored.description, roleDefinition: stored.roleDefinition } : builtin);

  useEffect(() => {
    const refresh = (event: StorageEvent) => {
      if (event.storageArea !== localStorage || (event.key !== TEMPLATE_STORAGE_KEY && event.key !== null &&
        !event.key.startsWith(TEMPLATE_ENTRY_PREFIX))) return;
      const latest = loadSavedTemplates();
      setSaved(latest);
      if (selection.startsWith("saved:") && !latest.some(({ id }) => id === selection.slice(6))) {
        setSelection(DEFAULT_SELECTION);
        setEdited(null);
      }
    };
    window.addEventListener("storage", refresh);
    return () => window.removeEventListener("storage", refresh);
  }, [selection]);

  const saveAs = () => {
    if (!name.trim()) return;
    try {
      // Each copy owns one key: simultaneous saves never replace another tab's table.
      // Legacy tables remain read-only, so reading old copies never races with new saves.
      const id = Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, "0")).join("");
      localStorage.setItem(TEMPLATE_ENTRY_PREFIX + id, JSON.stringify({ ...draft, id, name: name.trim() }));
      setSaved(readSavedTemplates());
      setSelection(`saved:${id}`);
      setEdited(null);
      setName("");
      setSaveFailed(false);
    } catch {
      setSaveFailed(true);
    }
  };

  return (
    <SettingsCard>
      <div className="flex flex-col gap-3 px-4 py-3 text-[13px]">
        <div>
          <h3 className="font-semibold">{t("templates.title")}</h3>
          <p className="text-muted-foreground">{t("templates.hint")}</p>
        </div>
        <label className="grid gap-1">
          {t("templates.choose")}
          <select className={INPUT_CLASS} value={selection} onChange={(event) => {
            setSelection(event.target.value);
            setEdited(null);
            setName("");
            setSaveFailed(false);
          }}>
            <optgroup label={t("templates.builtIn")}>
              {PROJECT_TEAM_ROLES.map((option) => (
                <option key={option} value={`builtin:${option}`}>{t(roleLabelKey(option))}</option>
              ))}
            </optgroup>
            {saved.length > 0 && <optgroup label={t("templates.saved")}>
              {saved.map((item) => (
                <option key={item.id} value={`saved:${item.id}`}>{item.name}</option>
              ))}
            </optgroup>}
          </select>
        </label>
        <label className="grid gap-1">
          {t("templates.description")}
          <LimitedTextArea value={draft.description} maxLength={PROJECT_TEAM_MAX_DESCRIPTION_LENGTH}
            onChange={(description) => setEdited({ ...draft, description })} />
        </label>
        <label className="grid gap-1">
          {t("templates.definition")}
          <LimitedTextArea value={draft.roleDefinition} maxLength={PROJECT_TEAM_MAX_ROLE_DEFINITION_LENGTH}
            onChange={(roleDefinition) => setEdited({ ...draft, roleDefinition })} />
        </label>
        <label className="grid gap-1">
          {t("templates.name")}
          <LimitedTextInput value={name} maxLength={PROJECT_TEAM_MAX_NAME_LENGTH} onChange={setName} />
        </label>
        <div className="flex flex-wrap gap-2">
          <button type="button" className={ACTION_CLASS} disabled={!onApply} onClick={() => {
            const { description, roleDefinition } = draft;
            onApply?.({ description, roleDefinition });
          }}>{t("templates.apply")}</button>
          <button type="button" className={ACTION_CLASS} disabled={!name.trim()} onClick={saveAs}>{t("templates.saveAs")}</button>
          <button type="button" className={ACTION_CLASS} onClick={() => {
            setSelection(`builtin:${role}`);
            setEdited(null);
            setName("");
            setSaveFailed(false);
          }}>{t("templates.restore")}</button>
        </div>
        {saveFailed && <p role="alert" className="text-destructive">{t("templates.storageError")}</p>}
      </div>
    </SettingsCard>
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
  const [roleChange, setRoleChange] = useState<{ id: string; from: ProjectAgentRole; to: ProjectAgentRole } | null>(null);

  if (!agent) {
    return (
      <div className="flex flex-col gap-3">
        <TemplateEditor />
        <EmptyPanel message={t("roles.selectAgent")} />
      </div>
    );
  }

  const roleOptions = PROJECT_TEAM_ROLES.map((role) => ({
    value: role,
    label: t(roleLabelKey(role)),
  }));

  const pendingRole = roleChange?.id === agent.id && roleChange.from === agent.role ? roleChange.to : null;
  const applyRoleChange = (role: ProjectAgentRole) => {
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
      <TemplateEditor onApply={(definition) => onChangeAgent(agent.id, definition)} />
      <div className="text-[13px]">
        <h3 className="font-semibold">{t("templates.member")}</h3>
        <p className="text-muted-foreground">{t("templates.memberHint")}</p>
      </div>
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

        <FormRow label={t("roles.role")} description={t("roles.roleHint")} announceChanges={false}>
          <Select
            value={agent.role}
            onChange={(next) => {
              const role = next as ProjectAgentRole;
              if (role !== agent.role) setRoleChange({ id: agent.id, from: agent.role, to: role });
            }}
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
      {pendingRole && (
        <ConfirmDialog
          title={t("roles.changeTitle", { role: t(roleLabelKey(pendingRole)) })}
          confirmLabel={t("roles.changeAction")}
          onCancel={() => setRoleChange(null)}
          onConfirm={() => {
            setRoleChange(null);
            applyRoleChange(pendingRole);
          }}
        >
          {t("roles.changeConfirm")}
        </ConfirmDialog>
      )}
    </div>
  );
}
