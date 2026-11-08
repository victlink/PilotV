/**
 * `ApprovalCenter` — file permissions of the approval store (A5).
 *
 * The store holds the pending decisions and the audit trail of the unified
 * approval center (统一审批中心). Both are created for the owner only: the
 * directory is 0700, the files are 0600. Permissions of files that already
 * exist are never rewritten — a running instance must not have its files
 * changed underneath it.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ApprovalCenter } from "./ApprovalCenter.js";

const SESSION_KEY = "session-permissions-1";

async function withStore<T>(run: (storeDir: string, center: ApprovalCenter) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-approval-permissions-"));
  // The store directory does not exist yet: the center has to create it.
  const storeDir = join(root, "approvals");
  const center = new ApprovalCenter({ storeDir });
  try {
    return await run(storeDir, center);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

test("the approval store directory is created for the owner only", async () => {
  await withStore(async (storeDir, center) => {
    await center.init();
    const info = await stat(storeDir);
    assert.equal(info.mode & 0o777, 0o700, "the store directory must be 0700");
  });
});

test("the state file and the audit file are created for the owner only", async () => {
  await withStore(async (storeDir, center) => {
    await center.init();
    await center.register({
      kind: "permission",
      sessionKey: SESSION_KEY,
      requestId: "req-permissions-1",
      toolName: "bash",
      originChannelKey: "feishu",
      risk: "high",
      summary: "synthetic approval request",
      payloadPreview: "(synthetic)",
    });

    const state = await stat(join(storeDir, "approvals.json"));
    assert.equal(state.mode & 0o777, 0o600, "the state file must be 0600");

    const audit = await stat(center.auditFilePath);
    assert.equal(audit.mode & 0o777, 0o600, "the audit file must be 0600");
  });
});

test("an existing audit file keeps the permissions it already has", async () => {
  await withStore(async (_storeDir, center) => {
    await center.init();
    // A file that exists already (for example because a previous version
    // created it) keeps its mode: only a newly created file gets 0600.
    await writeFile(center.auditFilePath, "", { encoding: "utf8", mode: 0o644 });
    await center.auditEvent({
      approvalId: "req-permissions-2",
      action: "registered",
      detail: "permission:bash:high",
    });

    const audit = await stat(center.auditFilePath);
    assert.equal(audit.mode & 0o777, 0o644, "an existing audit file must not be chmod-ed");
  });
});
