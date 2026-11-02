/**
 * 项目团队分区的前端校验文案。
 *
 * 为什么不放在 `i18n/locales/**` 里？
 *   `i18n/**` 属于其它并行任务的改动范围，本分区不允许新增 i18n 键；
 *   而只回退成 key 本身（例如 "projectTeam.validation.agentNameEmpty"）对用户
 *   毫无意义。因此这里直接产出**已经本地化**的完整句子，由调用方按当前语言取用。
 *
 * 语言判定：调用方通过 `useTranslation("projectTeam")` 拿到 `i18n.language`，
 * 用 `resolveProjectTeamLocale()` 归一化成 'en' | 'zh-CN'。
 */

import {
  PROJECT_TEAM_MAX_AGENTS,
  PROJECT_TEAM_MAX_TOOL_ENTRIES,
  type ProjectTeamDraftIssue,
  type ProjectToolListName,
} from "../../../../lib/projectTeam";

export type { ProjectTeamDraftIssue };

export type ProjectTeamLocale = "en" | "zh-CN";

/**
 * 把 i18n 的 language 归一化成两种受支持的界面语言。
 * 无法判断时回落到英文——界面本身的默认语言是英文。
 */
export function resolveProjectTeamLocale(
  language: string | undefined | null,
): ProjectTeamLocale {
  if (typeof language !== "string") return "en";
  return language.toLowerCase().startsWith("zh") ? "zh-CN" : "en";
}

/**
 * 工具条目的两个列表。
 * 后端对白名单与黑名单**分别**限制条目数量，所以文案必须点名是哪一个列表超限，
 * 否则用户不知道该删哪一边。
 */
const TOOL_LIST_LABELS: Record<
  ProjectToolListName,
  { field: string; en: string; zhCN: string }
> = {
  allowedTools: { field: "allowedTools", en: "allowed list", zhCN: "允许列表" },
  deniedTools: { field: "deniedTools", en: "denied list", zhCN: "禁止列表" },
};

/**
 * 把一个草稿问题渲染成完整句子。
 * `index` 是 0 基下标，展示时按 1 基编号。
 */
export function describeDraftIssue(
  issue: ProjectTeamDraftIssue,
  locale: ProjectTeamLocale,
): string {
  const position = issue.index + 1;

  switch (issue.kind) {
    case "agentNameEmpty":
      return locale === "zh-CN"
        ? `第 ${position} 个 Agent 缺少名称。`
        : `Agent #${position} needs a name.`;
    case "agentNameTooLong":
      return locale === "zh-CN"
        ? `第 ${position} 个 Agent 的名称最多 ${issue.max} 个字符。`
        : `Agent #${position} has a name longer than ${issue.max} characters.`;
    case "descriptionTooLong":
      return locale === "zh-CN"
        ? `第 ${position} 个 Agent 的职责描述最多 ${issue.max} 个字符。`
        : `Agent #${position} has a description longer than ${issue.max} characters.`;
    case "roleDefinitionTooLong":
      return locale === "zh-CN"
        ? `第 ${position} 个 Agent 的角色定义最多 ${issue.max} 个字符。`
        : `Agent #${position} has a role definition longer than ${issue.max} characters.`;
    case "modelProviderInvalid":
      return locale === "zh-CN"
        ? `第 ${position} 个 Agent 的模型提供方无效，只允许字母、数字、".", "_" 或 "-"。`
        : `Agent #${position} has an invalid model provider. Use letters, digits, ".", "_" or "-".`;
    case "modelIdInvalid":
      return locale === "zh-CN"
        ? `第 ${position} 个 Agent 的模型 id 无效，只允许字母、数字、".", "_", ":", "/" 或 "-"。`
        : `Agent #${position} has an invalid model id. Use letters, digits, ".", "_", ":", "/" or "-".`;
    case "tooManyToolEntries": {
      const list = TOOL_LIST_LABELS[issue.list] ?? TOOL_LIST_LABELS.allowedTools;
      return locale === "zh-CN"
        ? `第 ${position} 个 Agent 的 ${list.field}（${list.zhCN}）超过 ${issue.max} 条。`
        : `Agent #${position} has more than ${issue.max} entries in ${list.field} (${list.en}).`;
    }
    default:
      return locale === "zh-CN"
        ? "项目团队配置不合法。"
        : "The project team configuration is invalid.";
  }
}

/** 团队人数达到上限时的提示。 */
export function describeAgentLimitReached(locale: ProjectTeamLocale): string {
  return locale === "zh-CN"
    ? `每个项目最多 ${PROJECT_TEAM_MAX_AGENTS} 个 Agent，无法继续添加。`
    : `A project can hold at most ${PROJECT_TEAM_MAX_AGENTS} agents, so no more can be added.`;
}

/**
 * 单个工具列表的条目达到上限时的提示。
 * 上限是**每个列表**各自的限制：白名单写满不影响黑名单继续添加，
 * 所以这里不能说成"单个 Agent 最多 N 条"。
 */
export function describeToolLimitReached(locale: ProjectTeamLocale): string {
  return locale === "zh-CN"
    ? `每个工具列表最多 ${PROJECT_TEAM_MAX_TOOL_ENTRIES} 条工具条目，无法继续添加。`
    : `Each tool list holds at most ${PROJECT_TEAM_MAX_TOOL_ENTRIES} entries, so no more can be added.`;
}

/** 重新加载会丢弃未保存的修改时的确认文案。 */
export function describeUnsavedChanges(locale: ProjectTeamLocale): string {
  return locale === "zh-CN"
    ? "当前有未保存的修改。重新加载会丢弃这些修改，仍要继续吗？"
    : "You have unsaved changes. Reloading discards them. Continue?";
}
