import test from "node:test";
import assert from "node:assert/strict";
import { join, resolve, sep } from "node:path";
import { toolPolicyToRuleSet } from "./settings.js";

// Paths are built with resolve()/join() instead of hard-coded "/tmp/...":
// normalizeWriteRoots() resolves through node:path, which on Windows maps
// "/tmp/project" onto "<cwd drive>:\tmp\project". Asserting the literal POSIX
// string made these tests fail on every Windows run without indicating a bug.

const projectRoot = resolve(join("tmp", "project"));
const otherRoot = resolve(join("tmp", "other"));

test("toolPolicyToRuleSet carries the project write roots into the rule set", () => {
  const rules = toolPolicyToRuleSet({ deny: ["bash"], writeRoots: [projectRoot] });
  assert.deepEqual(rules.writeRoots, [projectRoot]);
});

test("toolPolicyToRuleSet omits write roots when the policy has none", () => {
  const rules = toolPolicyToRuleSet({ deny: ["bash"] });
  assert.equal(rules.writeRoots, undefined);
});

test("toolPolicyToRuleSet normalizes and de-duplicates write roots", () => {
  const withSeparator = projectRoot.endsWith(sep) ? projectRoot : projectRoot + sep;
  const rules = toolPolicyToRuleSet({
    writeRoots: [withSeparator, projectRoot, resolve(otherRoot, "..", "project")],
  });
  assert.deepEqual(rules.writeRoots, [projectRoot]);
});

test("toolPolicyToRuleSet keeps distinct write roots apart", () => {
  const rules = toolPolicyToRuleSet({ writeRoots: [projectRoot, otherRoot] });
  assert.deepEqual(rules.writeRoots, [projectRoot, otherRoot]);
});

test("toolPolicyToRuleSet keeps the exclusive allow list semantics", () => {
  assert.equal(toolPolicyToRuleSet({}).allowList, undefined);
  assert.deepEqual(toolPolicyToRuleSet({ allow: [] }).allowList, []);
});