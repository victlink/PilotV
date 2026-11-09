import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function findIndexFile(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i += 1) {
    const candidate = resolve(dir, "ui/server/index.js");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("ui/server/index.js not found");
}

test("P1: Web permission response passes the authenticated connection user as actor", async () => {
  const source = await readFile(findIndexFile(), "utf8");
  const marker = "await decidePermissionViaGateway(";
  const start = source.indexOf(marker);
  assert.notEqual(start, -1);
  const end = source.indexOf("\n                    );", start);
  assert.notEqual(end, -1);
  const call = source.slice(start, end);
  assert.match(call, /actor:\s*userId/);
  assert.doesNotMatch(call, /actor:\s*["'`]\w+["'`]/);
});
