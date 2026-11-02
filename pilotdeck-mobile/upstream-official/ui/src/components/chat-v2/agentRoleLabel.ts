import {
  PROJECT_AGENT_ROLE_TEMPLATES,
  type ProjectAgentRole,
} from "../../lib/projectTeam";

/**
 * The project team role names live in the `projectTeam` i18n namespace, not in
 * the chat namespace. `PROJECT_AGENT_ROLE_TEMPLATES[].labelKey` is written in
 * the `<namespace>.<key>` form used by `useTranslation("projectTeam")`, so it
 * is converted into the `<namespace>:<key>` form that `t()` expects when the
 * namespace is not the default one.
 */
const ROLE_LABEL_NAMESPACE = "projectTeam";

export function agentRoleLabelKey(role: unknown): string | null {
  if (typeof role !== "string") return null;
  const template = PROJECT_AGENT_ROLE_TEMPLATES[role as ProjectAgentRole];
  if (!template) return null;
  const labelKey = template.labelKey;
  if (!labelKey.startsWith(`${ROLE_LABEL_NAMESPACE}.`)) return null;
  return `${ROLE_LABEL_NAMESPACE}:${labelKey.slice(ROLE_LABEL_NAMESPACE.length + 1)}`;
}
