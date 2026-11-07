import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";

/**
 * 一次操作的全链路关联 id。
 *
 * 缺陷 B 排障时最大的困难不是没有日志，而是日志对不上：一条会话的压缩失败、
 * 一次工具调用报错、一条 ws 断开，分别落在不同行、由不同模块打出，没有任何
 * 共同字段能把它们串起来。排障方式因此退化成「按时间戳肉眼猜哪几行是一件事」。
 *
 * 这里只做一件事：给一次操作一个 id，让它在同一条链路上的每一层都能被读到。
 * 不做采样、不做 span 树、不接任何后端 —— 那些是另一次决策，且会先带来依赖。
 */

export const CORRELATION_ID_HEADER = "x-pilotv-correlation-id";

/** 日志里出现过的 id 必须是可 grep 的短串，不能是任意用户输入。 */
const CORRELATION_ID_PATTERN = /^[A-Za-z0-9_-]{6,64}$/;

const storage = new AsyncLocalStorage<{ correlationId: string; sessionKey?: string }>();

/** 生成一个 id。6 字节 base64url，够短，能在日志里一眼看完。 */
export function newCorrelationId(): string {
  return randomBytes(6).toString("base64url");
}

/**
 * 客户端可以自带 id（便于跨服务对齐），但只接受安全形状；
 * 不接受就自己生成 —— 绝不把未经校验的输入写进日志（日志注入）。
 */
export function resolveCorrelationId(candidate: unknown): string {
  const value = typeof candidate === "string" ? candidate.trim() : "";
  return CORRELATION_ID_PATTERN.test(value) ? value : newCorrelationId();
}

export type CorrelationContext = { correlationId: string; sessionKey?: string };

/** 在一段异步代码里绑定 id。回调抛出的原样往外传，这里不吞任何东西。 */
export function runWithCorrelation<T>(context: CorrelationContext, run: () => T): T {
  return storage.run(context, run);
}

/** 当前上下文的 id；不在任何上下文里时返回 null（调用方自己决定怎么兜底）。 */
export function currentCorrelation(): CorrelationContext | null {
  try {
    return storage.getStore() ?? null;
  } catch {
    return null;
  }
}

/**
 * 给日志器用的前缀。**永不抛**：它会被放进 catch 块和事件流主路径，
 * 观测代码在那种位置具备杀伤力就是缺陷 B 的复发形式（见 docs/DEGRADATION.md 第 4 节）。
 */
export function correlationPrefix(extra?: Partial<CorrelationContext> | null): string {
  try {
    const active = currentCorrelation();
    const id = extra?.correlationId || active?.correlationId;
    const sessionKey = extra?.sessionKey || active?.sessionKey;
    if (!id && !sessionKey) return "";
    const parts: string[] = [];
    if (id) parts.push(`corr=${id}`);
    if (sessionKey) parts.push(`session=${sessionKey}`);
    return `[${parts.join(" ")}] `;
  } catch {
    return "";
  }
}

/** 从 HTTP 头取值（Node 会把头转小写，且可能是数组）。 */
export function correlationIdFromHeaders(
  headers: Record<string, string | string[] | undefined> | undefined,
): string {
  const raw = headers?.[CORRELATION_ID_HEADER];
  return resolveCorrelationId(Array.isArray(raw) ? raw[0] : raw);
}
