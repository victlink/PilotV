import {
  Activity,
  Bot,
  ClipboardCheck,
  Code2,
  Cpu,
  Crown,
  Eye,
  Flag,
  Hammer,
  Medal,
  Search,
  Shield,
  ShieldCheck,
  UserRound,
  Users,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import { agentRoleLabelKey } from './agentRoleLabel';

/**
 * 发言人身份（图标 + 颜色）。
 *
 * - 同一位 agent 的每一次回复都用同一枚图标和同一种颜色，一眼能认出是谁在说话。
 * - 同一角色的多个成员按名字散列到不同变体，所以「两个审查」也不会撞成同一种颜色。
 * - 未知角色（后端可能回传 `engineer` 这类自定义角色）走通用调色板，不会退回灰色。
 */

export type SpeakerVariant = {
  Icon: LucideIcon;
  /** 文字颜色 */
  textClass: string;
  /** 徽标底色 */
  surfaceClass: string;
  /** 徽标描边 */
  borderClass: string;
};

export type AgentIdentity = {
  /** 稳定键：筛选与 React key 都用它 */
  key: string;
  /** 原始角色（commander / executor / reviewer / supervisor / 其它），主 agent 为空串 */
  role: string;
  /** 角色对应的 i18n key（`projectTeam:roles.xxx`）；未知角色为 null */
  roleLabelKey: string | null;
  /** agent 名字；主 agent 没有名字 */
  name: string;
  Icon: LucideIcon;
  textClass: string;
  surfaceClass: string;
  borderClass: string;
};

/** 主 agent（默认 agent）使用的键。 */
export const MAIN_SPEAKER_KEY = 'main';

const ROLE_VARIANTS: Record<string, SpeakerVariant[]> = {
  commander: [
    { Icon: Crown, textClass: 'text-amber-600 dark:text-amber-400', surfaceClass: 'bg-amber-50 dark:bg-amber-500/10', borderClass: 'border-amber-200 dark:border-amber-500/30' },
    { Icon: Flag, textClass: 'text-orange-600 dark:text-orange-400', surfaceClass: 'bg-orange-50 dark:bg-orange-500/10', borderClass: 'border-orange-200 dark:border-orange-500/30' },
    { Icon: Medal, textClass: 'text-yellow-600 dark:text-yellow-400', surfaceClass: 'bg-yellow-50 dark:bg-yellow-500/10', borderClass: 'border-yellow-200 dark:border-yellow-500/30' },
  ],
  executor: [
    { Icon: Code2, textClass: 'text-blue-600 dark:text-blue-400', surfaceClass: 'bg-blue-50 dark:bg-blue-500/10', borderClass: 'border-blue-200 dark:border-blue-500/30' },
    { Icon: Wrench, textClass: 'text-sky-600 dark:text-sky-400', surfaceClass: 'bg-sky-50 dark:bg-sky-500/10', borderClass: 'border-sky-200 dark:border-sky-500/30' },
    { Icon: Hammer, textClass: 'text-indigo-600 dark:text-indigo-400', surfaceClass: 'bg-indigo-50 dark:bg-indigo-500/10', borderClass: 'border-indigo-200 dark:border-indigo-500/30' },
  ],
  reviewer: [
    { Icon: Eye, textClass: 'text-violet-600 dark:text-violet-400', surfaceClass: 'bg-violet-50 dark:bg-violet-500/10', borderClass: 'border-violet-200 dark:border-violet-500/30' },
    { Icon: Search, textClass: 'text-purple-600 dark:text-purple-400', surfaceClass: 'bg-purple-50 dark:bg-purple-500/10', borderClass: 'border-purple-200 dark:border-purple-500/30' },
    { Icon: ClipboardCheck, textClass: 'text-fuchsia-600 dark:text-fuchsia-400', surfaceClass: 'bg-fuchsia-50 dark:bg-fuchsia-500/10', borderClass: 'border-fuchsia-200 dark:border-fuchsia-500/30' },
  ],
  supervisor: [
    { Icon: ShieldCheck, textClass: 'text-emerald-600 dark:text-emerald-400', surfaceClass: 'bg-emerald-50 dark:bg-emerald-500/10', borderClass: 'border-emerald-200 dark:border-emerald-500/30' },
    { Icon: Shield, textClass: 'text-teal-600 dark:text-teal-400', surfaceClass: 'bg-teal-50 dark:bg-teal-500/10', borderClass: 'border-teal-200 dark:border-teal-500/30' },
    { Icon: Activity, textClass: 'text-green-600 dark:text-green-400', surfaceClass: 'bg-green-50 dark:bg-green-500/10', borderClass: 'border-green-200 dark:border-green-500/30' },
  ],
};

/** 主 agent：默认没有名字，但也要有自己的图标和颜色。 */
const MAIN_VARIANTS: SpeakerVariant[] = [
  { Icon: Bot, textClass: 'text-slate-700 dark:text-slate-300', surfaceClass: 'bg-slate-100 dark:bg-slate-500/15', borderClass: 'border-slate-300 dark:border-slate-600' },
  { Icon: Cpu, textClass: 'text-zinc-700 dark:text-zinc-300', surfaceClass: 'bg-zinc-100 dark:bg-zinc-500/15', borderClass: 'border-zinc-300 dark:border-zinc-600' },
  { Icon: UserRound, textClass: 'text-stone-700 dark:text-stone-300', surfaceClass: 'bg-stone-100 dark:bg-stone-500/15', borderClass: 'border-stone-300 dark:border-stone-600' },
];

/** 后端自定义角色（不在四种标准角色里）的通用调色板。 */
const FALLBACK_VARIANTS: SpeakerVariant[] = [
  { Icon: Bot, textClass: 'text-rose-600 dark:text-rose-400', surfaceClass: 'bg-rose-50 dark:bg-rose-500/10', borderClass: 'border-rose-200 dark:border-rose-500/30' },
  { Icon: Cpu, textClass: 'text-cyan-700 dark:text-cyan-400', surfaceClass: 'bg-cyan-50 dark:bg-cyan-500/10', borderClass: 'border-cyan-200 dark:border-cyan-500/30' },
  { Icon: UserRound, textClass: 'text-lime-700 dark:text-lime-400', surfaceClass: 'bg-lime-50 dark:bg-lime-500/10', borderClass: 'border-lime-200 dark:border-lime-500/30' },
];

/** 「团队」聚合按钮的图标。 */
export const TEAM_ICON = Users;

/** FNV-1a：同一个名字永远散列到同一个变体。 */
export function hashKey(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash);
}

/** 团队成员的名字就是筛选键；主 agent 用固定键。 */
export function speakerKeyOfName(name: string | null | undefined): string {
  const trimmed = typeof name === 'string' ? name.trim() : '';
  return trimmed ? `name:${trimmed}` : MAIN_SPEAKER_KEY;
}

export function resolveAgentIdentity(input: {
  name?: string | null;
  role?: string | null;
}): AgentIdentity {
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  const role = typeof input.role === 'string' ? input.role.trim().toLowerCase() : '';
  const key = speakerKeyOfName(name);
  const variants = role
    ? (ROLE_VARIANTS[role] ?? FALLBACK_VARIANTS)
    : MAIN_VARIANTS;
  const variant = variants[hashKey(key) % variants.length];
  return {
    key,
    role,
    roleLabelKey: agentRoleLabelKey(role),
    name,
    Icon: variant.Icon,
    textClass: variant.textClass,
    surfaceClass: variant.surfaceClass,
    borderClass: variant.borderClass,
  };
}

/** 一条消息属于哪个发言人。 */
export function speakerKeyOfMessage(message: {
  agentName?: string | null;
  agentRole?: string | null;
}): string {
  return speakerKeyOfName(message.agentName);
}

/** 消息是否属于被选中的发言人。 */
export function messageMatchesSpeaker(
  message: { agentName?: string | null; agentRole?: string | null },
  speakerKey: string | null,
): boolean {
  if (!speakerKey) return true;
  return speakerKeyOfMessage(message) === speakerKey;
}

/**
 * 这条消息算不算「某位 agent 说出口的话」。
 *
 * 工具调用、思考过程、活动摘要都是过程而不是发言，筛选时不该被当成发言内容。
 */
export function isSpeakerUtterance(message: {
  type?: string;
  isThinking?: boolean;
  isToolUse?: boolean;
  isSubagentContainer?: boolean;
  isTaskNotification?: boolean;
  isAgentActivity?: boolean;
  isAgentActivitySummary?: boolean;
  isInteractivePrompt?: boolean;
  isInterruptedNotice?: boolean;
  content?: string;
}): boolean {
  if (message.type !== 'assistant') return false;
  if (message.isThinking || message.isToolUse || message.isSubagentContainer) return false;
  if (message.isTaskNotification || message.isAgentActivity || message.isAgentActivitySummary) return false;
  if (message.isInteractivePrompt || message.isInterruptedNotice) return false;
  return Boolean(message.content?.trim());
}

/**
 * 按发言人筛选：只留下选中发言人说出口的话，
 * 提问、工具过程这些上下文保持原样，方便读懂这一段在做什么。
 */
export function filterMessagesBySpeaker<T extends {
  type?: string;
  agentName?: string | null;
  agentRole?: string | null;
}>(messages: T[], speakerKey: string | null): T[] {
  if (!speakerKey) return messages;
  return messages.filter((message) => {
    if (!isSpeakerUtterance(message)) return true;
    return messageMatchesSpeaker(message, speakerKey);
  });
}

export type SpeakerEntry = {
  identity: AgentIdentity;
  /** 这个发言人的名字（主 agent 为空） */
  name: string;
  /** 同一个键下出现过的角色（后端可能先给角色后给名字） */
  role: string;
  /** 这个发言人说过话 */
  hasSpoken: boolean;
};

/**
 * chip 上显示的名字。
 *
 * 优先用角色的语义（指挥 / 审查 …），没有角色才退回 agent 名字，
 * 主 agent 没有名字也没有角色，用「主agent」这个身份词。
 */
export function speakerDisplayLabel(
  speaker: SpeakerEntry,
  translate: (key: string) => string,
  mainAgentLabel: string,
): string {
  const roleLabelKey = speaker.identity.roleLabelKey;
  if (roleLabelKey) {
    const roleLabel = translate(roleLabelKey);
    if (roleLabel && roleLabel !== roleLabelKey) return roleLabel;
  }
  if (!speaker.name) return mainAgentLabel;
  return speaker.name;
}

/**
 * 汇总这一轮对话里出现过的发言人。
 *
 * 顺序：主 agent → 团队配置里的成员 → 实际参与者 → 消息里出现过的其它发言人。
 */
export function collectSpeakers(input: {
  messages?: Array<{ agentName?: string | null; agentRole?: string | null }>;
  participants?: Array<{ agentId: string; name: string; role: string }>;
  agents?: Array<{ id: string; name: string; role: string }>;
  includeMain?: boolean;
}): SpeakerEntry[] {
  const order: string[] = [];
  const entries = new Map<string, SpeakerEntry>();

  const upsert = (
    name: string,
    role: string,
    options: { hasSpoken?: boolean } = {},
  ): void => {
    const identity = resolveAgentIdentity({ name, role });
    const existing = entries.get(identity.key);
    if (existing) {
      // 后到的角色比先到的更具体：主 agent 可能先以无名身份出现。
      if (!existing.role && identity.role) {
        existing.role = identity.role;
        existing.identity = resolveAgentIdentity({ name: existing.name, role: identity.role });
      }
      if (options.hasSpoken) existing.hasSpoken = true;
      return;
    }
    entries.set(identity.key, {
      identity,
      name: identity.name,
      role: identity.role,
      hasSpoken: Boolean(options.hasSpoken),
    });
    order.push(identity.key);
  };

  if (input.includeMain !== false) upsert('', '');

  for (const agent of input.agents ?? []) {
    upsert(agent.name ?? '', agent.role ?? '');
  }
  for (const participant of input.participants ?? []) {
    upsert(participant.name ?? '', participant.role ?? '');
  }
  for (const message of input.messages ?? []) {
    upsert(message.agentName ?? '', message.agentRole ?? '', { hasSpoken: true });
  }

  return order.map((key) => entries.get(key)!).filter(Boolean);
}
