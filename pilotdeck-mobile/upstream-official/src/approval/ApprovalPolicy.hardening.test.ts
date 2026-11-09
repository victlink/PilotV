/**
 * `ApprovalPolicy` — redaction hardening and tool-name risk ladder
 * (contract §3).
 *
 * Every sample below is synthetic. The point of each case is a *shape*:
 * a secret shape that survives the redaction pass leaks into the IM prompt
 * and into the audit trail, and a payload word that lifts the risk of a
 * harmless tool sends the request down the wrong authorization path.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  canDecideViaIm,
  classifyApprovalRisk,
  isSensitiveKey,
  looksLikeCredential,
  payloadContainsCredential,
  redactPayload,
} from "./ApprovalPolicy.js";

/* ------------------------------------------------------------------ *
 * A1 — redaction
 * ------------------------------------------------------------------ */

test("a credential inside a URL query string is redacted (contract §3)", () => {
  const result = redactPayload({
    url: "https://api.example.com/v1?api-key=sk_live_9f8e7d6c5b4a",
  });
  assert.equal(result.redacted, true, "the payload must be reported as redacted");
  assert.equal(
    result.preview.includes("sk_live_9f8e7d6c5b4a"),
    false,
    `the raw key must not survive: ${result.preview}`,
  );
  assert.equal(
    result.preview.includes("9f8e7d6c5b4a"),
    false,
    `no fragment of the key may survive: ${result.preview}`,
  );
  assert.equal(result.preview.includes("[redacted]"), true);
});

test("a token inside a URL query string is redacted even without a credential shape", () => {
  const result = redactPayload({
    url: "https://api.example.com/v1?token=abc123SECRETVALUE",
  });
  assert.equal(result.redacted, true);
  assert.equal(
    result.preview.includes("abc123SECRETVALUE"),
    false,
    `the raw token must not survive: ${result.preview}`,
  );
});

test("the sensitive key rule is normalized, so every spelling is caught", () => {
  for (const key of [
    "api-key",
    "api_key",
    "apiKey",
    "APIKey",
    "access_token",
    "accessToken",
    "clientSecret",
    "client-secret",
    "password",
    "x-api-key",
    "Cookie",
    "nonce",
    "sig",
    "signature",
  ]) {
    assert.equal(isSensitiveKey(key), true, `key "${key}" must be sensitive`);
    const result = redactPayload({ [key]: "value-that-must-not-leak" });
    assert.equal(result.redacted, true, `key "${key}" must trigger redaction`);
    assert.equal(
      result.preview.includes("value-that-must-not-leak"),
      false,
      `key "${key}" leaked its value: ${result.preview}`,
    );
  }
});

test("an ordinary payload is not redacted", () => {
  const result = redactPayload({ path: "src/a.ts" });
  assert.equal(result.redacted, false, `ordinary payload must stay readable: ${result.preview}`);
  assert.equal(result.preview.includes("src/a.ts"), true);
});

test("credential shapes are recognised", () => {
  for (const secret of [
    "sk_live_9f8e7d6c5b4a",
    "sk_test_9f8e7d6c5b4a",
    "sk_9f8e7d6c5b4a3f2",
    "pk_live_9f8e7d6c5b4a",
    "rk_live_9f8e7d6c5b4a",
    "0123456789abcdef0123456789abcdef01234567",
    "aB3dE5fG7hI9jK1mN2pQ4rS6tU8vW0xYz",
    "aB3dE5fG7hI9jK1mN2pQ4rS6tU8vW0x",
  ]) {
    assert.equal(looksLikeCredential(secret), true, `"${secret}" must look like a credential`);
    const result = redactPayload({ note: secret });
    assert.equal(result.redacted, true, `"${secret}" must be redacted`);
    assert.equal(
      result.preview.includes(secret),
      false,
      `"${secret}" leaked into the preview: ${result.preview}`,
    );
  }
});

test("ordinary long words are not credentials", () => {
  for (const text of [
    "src/a.ts",
    "pilotdeck-approval-bridge",
    "ThisIsATestStringOfThirtyTwoChars",
    "the token is expired",
  ]) {
    assert.equal(looksLikeCredential(text), false, `"${text}" must not look like a credential`);
  }
});

test("a payload only carries a credential when a value really is one", () => {
  assert.equal(payloadContainsCredential({ token: "abc" }), true);
  assert.equal(payloadContainsCredential({ url: "https://x.example/v1?api-key=sk_live_9f8e7d6c5b4a" }), true);
  assert.equal(payloadContainsCredential({ content: "the token is expired" }), false);
  assert.equal(payloadContainsCredential({ path: "src/a.ts" }), false);
});

/* ------------------------------------------------------------------ *
 * A2 — risk ladder
 * ------------------------------------------------------------------ */

test("shell, MCP and network tools are high risk (contract §3)", () => {
  for (const toolName of [
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
    "mcp__playwright__browser_click",
    "python",
    "npm",
    "pip",
    "git",
    "ssh",
    "scp",
    "rsync",
  ]) {
    assert.equal(
      classifyApprovalRisk({ kind: "permission", toolName }),
      "high",
      `tool "${toolName}" must be high risk`,
    );
  }
});

test("tools that write files directly are medium risk (contract §3)", () => {
  for (const toolName of [
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
  ]) {
    assert.equal(
      classifyApprovalRisk({ kind: "permission", toolName }),
      "medium",
      `tool "${toolName}" must be medium risk`,
    );
  }
});

test("every other tool is low risk (contract §3)", () => {
  for (const toolName of ["read_file", "glob", "grep", "list", "todo_write", "list_files"]) {
    assert.equal(
      classifyApprovalRisk({ kind: "permission", toolName }),
      "low",
      `tool "${toolName}" must be low risk`,
    );
  }
});

test("credential store tools stay critical (contract §3)", () => {
  for (const toolName of [
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
    "apikey",
    "access_token",
    "refresh_token",
  ]) {
    assert.equal(
      classifyApprovalRisk({ kind: "permission", toolName }),
      "critical",
      `tool "${toolName}" must be critical`,
    );
  }
});

test("a payload word does not rewrite the risk of the tool (contract §3)", () => {
  assert.equal(
    classifyApprovalRisk({
      kind: "permission",
      toolName: "write_file",
      payload: { content: "the token is expired" },
    }),
    "medium",
    "a payload that mentions a token must not lift a file write to critical",
  );
  assert.equal(
    classifyApprovalRisk({
      kind: "permission",
      toolName: "write_file",
      payload: { content: "agent" },
    }),
    "medium",
    "a payload that mentions an agent must not lift a file write to high",
  );
  assert.equal(
    classifyApprovalRisk({
      kind: "permission",
      toolName: "read_file",
      payload: { content: "vault" },
    }),
    "low",
    "a payload that mentions a vault must not lift a read to critical",
  );
});

test("a payload that really carries a credential is critical (contract §3)", () => {
  assert.equal(
    classifyApprovalRisk({
      kind: "permission",
      toolName: "read_file",
      payload: { url: "https://api.example.com/v1?api-key=sk_live_9f8e7d6c5b4a" },
    }),
    "critical",
    "a real credential in the payload must be critical",
  );
  assert.equal(
    classifyApprovalRisk({
      kind: "permission",
      toolName: "write_file",
      payload: { token: "abc" },
    }),
    "critical",
    "a sensitive key with a value must be critical",
  );
});

test("only low and medium risk requests may be answered from a chat channel", () => {
  assert.equal(canDecideViaIm("low"), true);
  assert.equal(canDecideViaIm("medium"), true);
  assert.equal(canDecideViaIm("high"), false);
  assert.equal(canDecideViaIm("critical"), false);
});
