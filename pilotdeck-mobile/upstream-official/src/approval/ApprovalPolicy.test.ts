/**
 * `ApprovalPolicy` — risk classification, payload redaction and IM
 * eligibility (contract §3).
 *
 * The samples are synthetic on purpose: no real credential ever enters this
 * file. The point of every case is that a *specific* secret shape must not
 * survive the redaction pass — a policy change that stops scrubbing one of
 * these shapes turns the corresponding case red.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  canDecideViaIm,
  classifyApprovalRisk,
  looksLikeCredential,
  redactPayload,
} from "./ApprovalPolicy.js";

test("a tool name that names a credential is critical", () => {
  for (const toolName of ["token", "api_key", "apikey", "secret", "password", "credential"]) {
    assert.equal(
      classifyApprovalRisk({ kind: "permission", toolName }),
      "critical",
      `tool name "${toolName}" must be classified as critical`,
    );
  }
});

test("a payload that names a credential is critical even for an innocuous tool", () => {
  for (const payload of [
    { token: "abc" },
    { api_key: "abc" },
    { apikey: "abc" },
    { secret: "abc" },
    { password: "abc" },
    { credential: "abc" },
  ]) {
    assert.equal(
      classifyApprovalRisk({ kind: "permission", toolName: "read_file", payload }),
      "critical",
      `payload ${JSON.stringify(payload)} must be classified as critical`,
    );
  }
});

test("a payload that looks like a live credential is upgraded to critical", () => {
  // The tool is harmless, the *content* is not: a credential-looking value
  // must force the critical level even when no key name says "secret".
  assert.equal(
    classifyApprovalRisk({
      kind: "permission",
      toolName: "read_file",
      payload: { note: "sk-proj-1234567890" },
    }),
    "critical",
  );
  assert.equal(
    classifyApprovalRisk({
      kind: "permission",
      toolName: "read_file",
      payload: "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abc",
    }),
    "critical",
  );
});

test("an ordinary tool stays on the ordinary risk ladder", () => {
  assert.equal(classifyApprovalRisk({ kind: "permission", toolName: "bash" }), "high");
  assert.equal(classifyApprovalRisk({ kind: "permission", toolName: "write_file" }), "medium");
  assert.equal(
    classifyApprovalRisk({ kind: "permission", toolName: "read_file", payload: { path: "src/a.ts" } }),
    "low",
  );
});

test("redactPayload removes an exported API key from the preview", () => {
  const { preview, redacted } = redactPayload("OPENAI_API_KEY=sk-proj-1234567890");
  assert.equal(redacted, true);
  assert.equal(preview.includes("sk-proj-1234567890"), false);
  assert.equal(preview.includes("1234567890"), false);
});

test("redactPayload removes an exported token from the preview", () => {
  const { preview, redacted } = redactPayload("export TOKEN=abc123");
  assert.equal(redacted, true);
  assert.equal(preview.includes("abc123"), false);
  assert.equal(preview.includes("TOKEN"), true, "the key name may stay, the value may not");
});

test("redactPayload removes a password from the preview", () => {
  const { preview, redacted } = redactPayload({ password: "hunter2" });
  assert.equal(redacted, true);
  assert.equal(preview.includes("hunter2"), false);
});

test("redactPayload removes a bearer token from the preview", () => {
  const { preview, redacted } = redactPayload("Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abc");
  assert.equal(redacted, true);
  assert.equal(preview.includes("eyJhbGciOiJIUzI1NiJ9.abc"), false);
});

test("redactPayload removes a non-string credential value from the preview", () => {
  // The value is a number, not a string: the JSON string branch cannot help
  // here, the numeric branch has to catch it.
  const { preview, redacted } = redactPayload({ api_key: 12345678 });
  assert.equal(redacted, true);
  assert.equal(preview.includes("12345678"), false);

  const raw = redactPayload("api_key: 12345678");
  assert.equal(raw.redacted, true);
  assert.equal(raw.preview.includes("12345678"), false);
});

test("redactPayload leaves an ordinary payload alone", () => {
  const { preview, redacted } = redactPayload({ path: "src/a.ts" });
  assert.equal(redacted, false);
  assert.equal(preview.includes("src/a.ts"), true);
});

test("looksLikeCredential separates credentials from ordinary text", () => {
  assert.equal(looksLikeCredential("sk-proj-1234567890"), true);
  assert.equal(looksLikeCredential("Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abc"), true);
  assert.equal(looksLikeCredential("src/a.ts"), false);
  assert.equal(looksLikeCredential(""), false);
});

test("only low and medium risk requests may be answered from a chat channel", () => {
  assert.equal(canDecideViaIm("low"), true);
  assert.equal(canDecideViaIm("medium"), true);
  assert.equal(canDecideViaIm("high"), false);
  assert.equal(canDecideViaIm("critical"), false);
});
