/**
 * Risk classification, payload redaction and IM eligibility for approvals.
 *
 * The rules are deterministic and tool-name based: the backend computes the
 * risk, the UI and the chat channels only render it.
 *
 * Two invariants drive the implementation:
 *
 *  1. The *tool* decides the risk (contract §3). A payload word never
 *     rewrites the risk of the tool itself — only a payload that really
 *     carries a credential may lift it to `critical`.
 *  2. Redaction runs before the payload reaches a prompt or the audit
 *     trail (contract §3). A secret shape that survives the pass is a
 *     leak, so the detectors deliberately over-match: a false positive only
 *     hides a value, a false negative exposes a credential.
 */

import type { ApprovalKind, ApprovalRisk } from "./types.js";

export const APPROVAL_TTL_MS = 10 * 60 * 1000;

/* ------------------------------------------------------------------ *
 * Tool name risk ladder (contract §3)
 * ------------------------------------------------------------------ */

/**
 * Tools that reach into a credential store.
 *
 * A request for one of them is `critical`: it never leaves the native
 * authorization interface and it is never answered from a chat channel.
 */
const CRITICAL_TOOL_NAMES = [
  "bitwarden",
  "vault",
  "keychain",
  "password",
  "passphrase",
  "secret",
  "credential",
  "private_key",
  "token",
  "api_key",
  "access_token",
  "refresh_token",
];

/** Tools that run a shell, talk to the network or drive an agent (contract §3). */
const HIGH_TOOL_NAMES = [
  "bash",
  "sh",
  "shell",
  "zsh",
  "exec",
  "execute_code",
  "spawn",
  "curl",
  "wget",
  "http_fetch",
  "web_fetch",
  "web_search",
  "fetch",
  "browser",
  "agent",
  "task_create",
  "mcp",
  "python",
  "npm",
  "pip",
  "git",
  "ssh",
  "scp",
  "rsync",
];

/** Tools that write to the file system directly (contract §3). */
const MEDIUM_TOOL_NAMES = [
  "write_file",
  "edit_file",
  "edit_notebook",
  "create_file",
  "append_file",
  "delete",
  "delete_file",
  "move",
  "rename",
  "mkdir",
  "rm",
];

/* ------------------------------------------------------------------ *
 * Sensitive keys and credential shapes
 * ------------------------------------------------------------------ */

/**
 * Words that mark a payload key as sensitive.
 *
 * `boundaryOnly` words are only matched as a whole segment of the key
 * (`sig`, `key`): they are short enough to occur inside ordinary words
 * (`design`, `monkey`), and a false positive would hide a harmless value
 * and force an unnecessary `critical` risk.
 */
const SENSITIVE_KEY_WORDS: Array<{ word: string; boundaryOnly?: boolean }> = [
  { word: "pass" },
  { word: "secret" },
  { word: "token" },
  { word: "key", boundaryOnly: true },
  { word: "credential" },
  { word: "cookie" },
  { word: "auth" },
  { word: "apikey" },
  { word: "sig", boundaryOnly: true },
  { word: "signature" },
  { word: "nonce" },
];

/** Credential prefixes that are unambiguous on their own. */
const CREDENTIAL_VALUE_PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{8,}/,
  /\bsk_[A-Za-z0-9_-]{12,}/,
  /\bsk_live_[A-Za-z0-9_-]{8,}/,
  /\bsk_test_[A-Za-z0-9_-]{8,}/,
  /\bpk_live_[A-Za-z0-9_-]{8,}/,
  /\brk_live_[A-Za-z0-9_-]{8,}/,
  /\bghp_[A-Za-z0-9]{16,}/,
  /\bgithub_pat_[A-Za-z0-9_]{16,}/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/,
  /\bAKIA[0-9A-Z]{12,}/,
  /\beyJ[A-Za-z0-9_-]{6,}(?:\.[A-Za-z0-9_-]{4,}){0,2}/,
];

const PEM_BLOCK = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;
const BEARER_VALUE = /\bbearer\s+[A-Za-z0-9._~+/=-]{8,}/i;

/** A run of hex characters long enough to be a digest, not a word. */
const HEX_RUN = /(?<![0-9A-Za-z])[0-9a-f]{24,}(?![0-9A-Za-z])/i;
/** A run that could be standard base64. */
const BASE64_RUN = /[A-Za-z0-9+/]{32,}/g;
/** A run that could be URL-safe base64. */
const URLSAFE_RUN = /[A-Za-z0-9_-]{20,}/g;

/** `key=value` / `key: value` pairs inside free text. */
const KEY_VALUE_PAIR = /(^|[\s,{;"'])([A-Za-z_][A-Za-z0-9_.-]*)(\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;}\]]+)/g;
/** `?a=1&b=2` query strings, inside a URL that is embedded in any text. */
const URL_QUERY_PAIR = /([?&])([A-Za-z0-9_.\-[\]]+)=([^&\s"'#]*)/g;

/* ------------------------------------------------------------------ *
 * Key helpers
 * ------------------------------------------------------------------ */

/**
 * Split a payload key into its segments.
 *
 * `api-key`, `api_key`, `apiKey` and `API_KEY` all yield `["api","key"]`,
 * so the sensitive-key rule below sees one shape instead of four.
 */
function keySegments(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter((part) => part.length > 0)
    .map((part) => part.toLowerCase());
}

/**
 * True when a payload key names a secret.
 *
 * The key is normalized first (separators removed, lower-cased), so
 * `api-key`, `api_key`, `apiKey`, `access_token`, `accessToken` and
 * `clientSecret` are all recognised as the same rule.
 */
export function isSensitiveKey(key: string): boolean {
  const segments = keySegments(key);
  const normalized = segments.join("");
  return SENSITIVE_KEY_WORDS.some(({ word, boundaryOnly }) =>
    boundaryOnly ? segments.includes(word) : normalized.includes(word),
  );
}

/** True when a value carries information (an empty value hides nothing). */
function hasContent(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value as object).length > 0;
  return true;
}

/* ------------------------------------------------------------------ *
 * Tool name matching
 * ------------------------------------------------------------------ */

/** Normalize a tool name: lower case, separators collapsed to `_`. */
function normalizeToolName(toolName: string): string {
  return toolName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/**
 * True when the tool name contains one of the markers.
 *
 * The marker may be the whole name, one of its segments (`read_secret`
 * matches `secret`) or a run of adjacent segments (`read_private_key`
 * matches `private_key`). Segment matching avoids the substring traps of
 * short markers — `sh` must not match `push`, `rm` must not match `transform`.
 */
function toolNameMatches(toolName: string, markers: string[]): boolean {
  const normalized = normalizeToolName(toolName);
  if (!normalized) return false;
  const segments = normalized.split("_").filter((part) => part.length > 0);
  const nameLetters = normalized.replace(/_/g, "");
  for (const marker of markers) {
    // `api_key` and `apiKey` name the same tool, so the marker is compared
    // with and without its separator.
    const markerLetters = marker.replace(/_/g, "");
    if (normalized === marker || nameLetters === markerLetters) return true;
    if (segments.includes(marker)) return true;
    if (segments.some((segment) => segment === markerLetters)) return true;
    for (let start = 0; start < segments.length; start += 1) {
      for (let end = start + 1; end <= segments.length; end += 1) {
        const window = segments.slice(start, end).join("_");
        if (window === marker || window.replace(/_/g, "") === markerLetters) return true;
      }
    }
  }
  return false;
}

/** The risk the tool itself carries (contract §3). */
function riskFromToolName(toolName: string): ApprovalRisk {
  if (toolNameMatches(toolName, CRITICAL_TOOL_NAMES)) return "critical";
  if (toolNameMatches(toolName, HIGH_TOOL_NAMES)) return "high";
  if (toolNameMatches(toolName, MEDIUM_TOOL_NAMES)) return "medium";
  return "low";
}

/* ------------------------------------------------------------------ *
 * Credential detection
 * ------------------------------------------------------------------ */

/**
 * True when a text carries something that looks like a secret.
 *
 * Besides the well known prefixes this also accepts high entropy runs: a
 * long hex digest and a long mixed-case base64 blob are credentials far
 * more often than they are prose.
 */
export function looksLikeCredential(text: string): boolean {
  if (!text) return false;
  if (PEM_BLOCK.test(text)) return true;
  if (BEARER_VALUE.test(text)) return true;
  if (CREDENTIAL_VALUE_PATTERNS.some((pattern) => pattern.test(text))) return true;
  return hasHighEntropySecret(text);
}

/** Long hex / base64 runs that are secrets rather than words. */
function hasHighEntropySecret(text: string): boolean {
  if (HEX_RUN.test(text)) return true;
  for (const run of text.match(BASE64_RUN) ?? []) {
    if (/[a-z]/.test(run) && /[A-Z]/.test(run) && /[0-9]/.test(run)) return true;
  }
  for (const run of text.match(URLSAFE_RUN) ?? []) {
    // A URL-safe base64 blob mixes letters and digits; a plain long word
    // (a path segment, an identifier) does not and stays untouched.
    if (!/[A-Za-z]/.test(run) || !/[0-9]/.test(run)) continue;
    if (/[A-Z]/.test(run) || /[_-]/.test(run)) return true;
  }
  return false;
}

/** True when a `key=value` / `key: value` pair names a secret. */
function textHasSensitivePair(text: string): boolean {
  KEY_VALUE_PAIR.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = KEY_VALUE_PAIR.exec(text)) !== null) {
    const key = match[2] ?? "";
    const rawValue = (match[4] ?? "").replace(/^["']|["']$/g, "");
    if (isSensitiveKey(key) && hasContent(rawValue)) return true;
  }
  URL_QUERY_PAIR.lastIndex = 0;
  while ((match = URL_QUERY_PAIR.exec(text)) !== null) {
    const key = match[2] ?? "";
    const value = match[3] ?? "";
    if (isSensitiveKey(key) && hasContent(value)) return true;
  }
  return false;
}

/**
 * True when the payload really carries a credential.
 *
 * "Really" means: a sensitive key with a non-empty value, or a value that
 * matches a credential shape. A payload that merely mentions the word
 * `token` (a log line, a file name) is *not* a credential.
 */
export function payloadContainsCredential(payload: unknown): boolean {
  return detectCredential(payload, 0);
}

function detectCredential(value: unknown, depth: number): boolean {
  if (depth > 6) return false;
  if (value === null || value === undefined) return false;
  if (typeof value === "string") {
    return looksLikeCredential(value) || textHasSensitivePair(value);
  }
  if (typeof value !== "object") return false;
  if (Array.isArray(value)) {
    return value.some((entry) => detectCredential(entry, depth + 1));
  }
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (isSensitiveKey(key) && hasContent(entry)) return true;
    if (detectCredential(entry, depth + 1)) return true;
  }
  return false;
}

/* ------------------------------------------------------------------ *
 * Public API
 * ------------------------------------------------------------------ */

/**
 * Risk of an approval request (contract §3).
 *
 * The tool decides the risk. A payload only lifts the risk to `critical`
 * when it really carries a credential — a payload that names a credential
 * (`token`, `vault`, `agent`) without carrying one keeps the tool's risk.
 */
export function classifyApprovalRisk(input: {
  kind: ApprovalKind;
  toolName: string;
  payload?: unknown;
}): ApprovalRisk {
  const toolRisk = riskFromToolName(input.toolName ?? "");
  if (toolRisk === "critical") return "critical";
  if (payloadContainsCredential(input.payload)) return "critical";
  return toolRisk;
}

/**
 * Only `low` and `medium` may be answered from a chat channel.
 *
 * `high` and `critical` stay in the native authorization interface: a
 * casual "同意" in a chat must not unlock a shell (contract §3).
 */
export function canDecideViaIm(risk: ApprovalRisk): boolean {
  return risk === "low" || risk === "medium";
}

/**
 * Redacted, human readable preview of a payload (contract §3).
 *
 * Everything that looks like a secret is replaced by `[redacted]` before
 * the text may reach a prompt or the audit trail.
 */
export function redactPayload(payload: unknown): { preview: string; redacted: boolean } {
  let redacted = false;
  const mark = (value: string): string => {
    redacted = true;
    return value;
  };

  let scrubbed = safeText(payload);

  // 1. Private key blocks.
  scrubbed = scrubbed.replace(
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    () => mark("[redacted]"),
  );

  // 2. `Authorization: Bearer <token>`.
  scrubbed = scrubbed.replace(/\bbearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, () => mark("[redacted]"));

  // 3. Bare credential values (`sk_live_…`, `AKIA…`, `eyJ…`, …).
  for (const pattern of CREDENTIAL_VALUE_PATTERNS) {
    scrubbed = scrubbed.replace(new RegExp(pattern.source, "g"), () => mark("[redacted]"));
  }

  // 4. Query strings of URLs that are embedded in the text: a sensitive
  //    parameter loses its value, and a parameter whose *value* looks like a
  //    credential loses it too. This also covers URLs inside a JSON string
  //    value, which the JSON branch below never sees.
  scrubbed = scrubbed.replace(URL_QUERY_PAIR, (match, separator: string, key: string, value: string) => {
    if (!isSensitiveKey(key) && !looksLikeCredential(value)) return match;
    return mark(`${separator}${key}=[redacted]`);
  });

  // 5. JSON string values: `{"api-key":"…"}`.
  scrubbed = scrubbed.replace(
    /"([^"\\]*)"\s*:\s*"([^"\\]*)"/g,
    (match, key: string, value: string) => {
      if (isSensitiveKey(key)) return mark(`"${key}":"[redacted]"`);
      if (looksLikeCredential(value)) return mark(`"${key}":"[redacted]"`);
      return match;
    },
  );

  // 6. JSON values that are not strings: `{"password":12345678}`.
  scrubbed = scrubbed.replace(
    /"([^"\\]*)"\s*:\s*(-?\d+(?:\.\d+)?|true|false|null)/gi,
    (match, key: string) => {
      if (!isSensitiveKey(key)) return match;
      return mark(`"${key}":"[redacted]"`);
    },
  );

  // 7. `KEY=value` / `KEY: value` in free text.
  scrubbed = scrubbed.replace(
    KEY_VALUE_PAIR,
    (match, lead: string, key: string, separator: string, value: string) => {
      if (isSensitiveKey(key)) {
        return mark(`${lead}${key}${separator}[redacted]`);
      }
      const bare = value.replace(/^["']|["']$/g, "");
      if (looksLikeCredential(bare)) {
        return mark(`${lead}${key}${separator}[redacted]`);
      }
      return match;
    },
  );

  const preview = scrubbed.length > 600 ? `${scrubbed.slice(0, 600)}…` : scrubbed;
  return { preview, redacted };
}

function safeText(payload: unknown): string {
  if (typeof payload === "string") return payload;
  try {
    return JSON.stringify(payload) ?? "";
  } catch {
    return String(payload ?? "");
  }
}
