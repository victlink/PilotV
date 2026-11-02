import {
  PROJECT_AGENT_ROLE_TEMPLATES,
  type ProjectAgentRole,
} from "../../../../lib/projectTeam";
import type { ProjectTeamLocale } from "./validationMessages";

const NAMESPACE_PREFIX = "projectTeam.";

/**
 * `PROJECT_AGENT_ROLE_TEMPLATES` 的 labelKey 自带命名空间前缀（`projectTeam.roles.commander`）。
 * 组件用 `useTranslation("projectTeam")` 渲染，所以这里去掉前缀，只留资源内的键路径。
 */
export function roleLabelKey(role: ProjectAgentRole): string {
  const labelKey = PROJECT_AGENT_ROLE_TEMPLATES[role]?.labelKey ?? "";
  return labelKey.startsWith(NAMESPACE_PREFIX)
    ? labelKey.slice(NAMESPACE_PREFIX.length)
    : labelKey;
}

type AgentTemplate = { description: string; roleDefinition: string };

/**
 * 各角色的默认说明文案。
 *
 * `PROJECT_AGENT_ROLE_TEMPLATES` 里的默认值是中文（写死在共享的 lib 层），
 * 英文界面不应该出现中文默认值，所以这里额外提供一份英文文案；
 * 中文沿用 lib 里的原文，避免两处漂移。
 */
const ROLE_TEMPLATES: Record<ProjectAgentRole, Record<ProjectTeamLocale, AgentTemplate>> = {
  commander: {
    "zh-CN": {
      description: PROJECT_AGENT_ROLE_TEMPLATES.commander.description,
      roleDefinition: PROJECT_AGENT_ROLE_TEMPLATES.commander.roleDefinition,
    },
    en: {
      description: "Break down tasks, delegate the work, and summarize the outcome",
      roleDefinition:
        "Owns requirement breakdown and delegation; coordinates only and never edits code directly.",
    },
  },
  executor: {
    "zh-CN": {
      description: PROJECT_AGENT_ROLE_TEMPLATES.executor.description,
      roleDefinition: PROJECT_AGENT_ROLE_TEMPLATES.executor.roleDefinition,
    },
    en: {
      description: "Implement the assigned work and self-test it",
      roleDefinition:
        "Owns the implementation; self-tests afterwards and reports the scope of the change and the risks.",
    },
  },
  reviewer: {
    "zh-CN": {
      description: PROJECT_AGENT_ROLE_TEMPLATES.reviewer.description,
      roleDefinition: PROJECT_AGENT_ROLE_TEMPLATES.reviewer.roleDefinition,
    },
    en: {
      description: "Review the implementation and the regression risks",
      roleDefinition:
        "Reviews and verifies only; never modifies code and reports a reproducible list of issues.",
    },
  },
  supervisor: {
    "zh-CN": {
      description: PROJECT_AGENT_ROLE_TEMPLATES.supervisor.description,
      roleDefinition: PROJECT_AGENT_ROLE_TEMPLATES.supervisor.roleDefinition,
    },
    en: {
      description: "Track progress, provide fallbacks, and check compliance",
      roleDefinition:
        "Owns process supervision and fallbacks: progress, blockers, and compliance checks.",
    },
  },
};

/**
 * 新建 Agent 时带出来的默认描述与角色定义（按界面语言）。
 * 角色切换时同样用它重置描述与角色定义。
 */
export function getDefaultAgentTemplate(
  role: ProjectAgentRole,
  locale: ProjectTeamLocale,
): AgentTemplate {
  return (
    ROLE_TEMPLATES[role]?.[locale] ?? {
      description: PROJECT_AGENT_ROLE_TEMPLATES[role]?.description ?? "",
      roleDefinition: PROJECT_AGENT_ROLE_TEMPLATES[role]?.roleDefinition ?? "",
    }
  );
}
