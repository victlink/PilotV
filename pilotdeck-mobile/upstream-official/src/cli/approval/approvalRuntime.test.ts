import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ApprovalCenter } from "../../approval/ApprovalCenter.js";
import { ApprovalRouter, type ApprovalCapableChannel } from "../../approval/ApprovalRouter.js";

test("resolveChannel dynamically reflects registration changes", async () => {
  const storeDir = await mkdtemp(join(tmpdir(), "pilotdeck-approval-router-"));
  try {
    let registered: ApprovalCapableChannel | undefined;
    const gateway = { permissionDecide: async () => ({ delivered: false }) };
    const router = new ApprovalRouter({
      center: new ApprovalCenter({ storeDir }),
      gateway,
      resolveChannel: (channelKey) => registered?.channelKey === channelKey ? registered : undefined,
      bindingConfigs: () => [],
    });
    const resolveChannel = (router as unknown as { resolveChannel: (channelKey: string) => ApprovalCapableChannel | undefined }).resolveChannel;
    assert.equal(resolveChannel("feishu"), undefined);
    registered = { channelKey: "feishu" };
    assert.equal(resolveChannel("feishu"), registered);
  } finally {
    await rm(storeDir, { recursive: true, force: true });
  }
});
