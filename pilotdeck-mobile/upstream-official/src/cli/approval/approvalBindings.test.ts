import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadApprovalBindingConfigs } from "./approvalBindings.js";

test("missing bindings file returns an empty array", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pilotdeck-approval-"));
  try {
    assert.deepEqual(loadApprovalBindingConfigs(join(dir, "missing.json")), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("damaged bindings file returns empty and warns", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pilotdeck-approval-"));
  try {
    const file = join(dir, "approval-bindings.json");
    await writeFile(file, "{not-json", "utf8");
    const warnings: string[] = [];
    assert.deepEqual(loadApprovalBindingConfigs(file, { logger: { warn: (message) => warnings.push(message) } }), []);
    assert.equal(warnings.length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("valid bindings preserve routing fields", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pilotdeck-approval-"));
  try {
    const file = join(dir, "approval-bindings.json");
    await writeFile(file, JSON.stringify({ bindings: [{
      channelKey: "feishu",
      chatId: "oc_xxx",
      approverIds: ["ou_xxx"],
      projectKeys: ["project-a"],
      toolNames: ["write_file"],
    }] }), "utf8");
    assert.deepEqual(loadApprovalBindingConfigs(file), [{
      channelKey: "feishu",
      chatId: "oc_xxx",
      approverIds: ["ou_xxx"],
      projectKeys: ["project-a"],
      toolNames: ["write_file"],
    }]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("invalid binding is skipped while valid entries remain", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pilotdeck-approval-"));
  try {
    const file = join(dir, "approval-bindings.json");
    await writeFile(file, JSON.stringify({ bindings: [
      { channelKey: "", chatId: "missing-channel" },
      { channelKey: "wecom", chatId: "chat-ok" },
    ] }), "utf8");
    const warnings: string[] = [];
    assert.deepEqual(loadApprovalBindingConfigs(file, { logger: { warn: (message) => warnings.push(message) } }), [
      { channelKey: "wecom", chatId: "chat-ok" },
    ]);
    assert.equal(warnings.length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
