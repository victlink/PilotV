import { randomUUID } from "node:crypto";
import { existsSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { CheckpointStore } from "./WorkspaceCheckpoints.js";
import type { Checkpoint } from "./types.js";

type Fixture = { root: string; store: CheckpointStore; manifests: string; objects: string };

async function fixture(): Promise<Fixture> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pilotdeck-checkpoint-gc-"));
  const workspace = path.join(root, "workspace");
  const directory = path.join(root, "checkpoints");
  await fs.mkdir(workspace, { recursive: true });
  const manifests = path.join(directory, "manifests");
  const objects = path.join(directory, "objects");
  await fs.mkdir(manifests, { recursive: true });
  await fs.mkdir(objects, { recursive: true });
  return { root, store: new CheckpointStore(workspace, directory), manifests, objects };
}

async function blob(store: CheckpointStore, content: string): Promise<string> {
  return store.putObject(Buffer.from(content));
}

async function manifest(store: CheckpointStore, hash: string, sessionId = "session-1"): Promise<Checkpoint> {
  const checkpoint: Checkpoint = {
    version: 1,
    id: randomUUID(),
    sessionId,
    turnId: randomUUID(),
    workspace: store.workspace,
    createdAt: new Date().toISOString(),
    phase: "after",
    status: "complete",
    files: { "keep.txt": { kind: "file", hash, size: 1, mode: 0o644, binary: false } },
  };
  await store.save(checkpoint);
  return checkpoint;
}

describe("CheckpointStore garbage collection", () => {
  it("keeps a blob referenced by a corrupt manifest", async () => {
    const { root, store, manifests, objects } = await fixture();
    try {
      const corrupt = await blob(store, "referenced-by-corrupt-manifest");
      const healthy = await blob(store, "referenced-by-healthy-manifest");
      await manifest(store, healthy);
      await fs.writeFile(path.join(manifests, `${randomUUID()}.json`),
        `{"version":1,"id":"${randomUUID()}","sessionId":"session-1","phase":"after","files":{"keep.txt":{"kind":"file","hash":"${corrupt}"`, "utf8");
      await store.prune();
      assert.equal(existsSync(path.join(objects, corrupt)), true, "blob referenced by a corrupt manifest must survive garbage collection");
      assert.equal(existsSync(path.join(objects, healthy)), true, "blob referenced by a readable manifest must survive garbage collection");
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it("keeps a blob referenced by a manifest that cannot be read", async () => {
    const { root, store, manifests, objects } = await fixture();
    try {
      const unreadable = await blob(store, "referenced-by-unreadable-manifest");
      const healthy = await blob(store, "referenced-by-healthy-manifest");
      await manifest(store, healthy);
      await fs.mkdir(path.join(manifests, `${randomUUID()}.json`), { recursive: true });
      await store.prune();
      assert.equal(existsSync(path.join(objects, unreadable)), true, "blob referenced by an unreadable manifest must survive garbage collection");
      assert.equal(existsSync(path.join(objects, healthy)), true);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it("still collects unreferenced blobs when every record is readable", async () => {
    const { root, store, objects } = await fixture();
    try {
      const referenced = await blob(store, "referenced");
      const orphan = await blob(store, "orphan");
      await manifest(store, referenced);
      await store.prune();
      assert.equal(existsSync(path.join(objects, referenced)), true, "referenced blob must survive");
      assert.equal(existsSync(path.join(objects, orphan)), false, "unreferenced blob must be collected");
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it("keeps listing tolerant of an unreadable manifest", async () => {
    const { root, store, manifests } = await fixture();
    try {
      const healthy = await manifest(store, await blob(store, "listed"), "session-list");
      await fs.writeFile(path.join(manifests, `${randomUUID()}.json`), "{not json", "utf8");
      await fs.mkdir(path.join(manifests, `${randomUUID()}.json`), { recursive: true });
      const listed = await store.list("session-list");
      assert.deepEqual(listed.map(record => record.id), [healthy.id]);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
});
