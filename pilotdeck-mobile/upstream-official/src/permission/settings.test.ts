import test from "node:test";
import assert from "node:assert/strict";
import { toolPolicyToRuleSet } from "./settings.js";

test("toolPolicyToRuleSet carries the project write roots into the rule set", () => {
  const rules = toolPolicyToRuleSet({ deny: ["bash"], writeRoots: ["/tmp/project"] });
  assert.deepEqual(rules.writeRoots, ["/tmp/project"]);
});

test("toolPolicyToRuleSet omits write roots when the policy has none", () => {
  const rules = toolPolicyToRuleSet({ deny: ["bash"] });
  assert.equal(rules.writeRoots, undefined);
});

test("toolPolicyToRuleSet normalizes and de-duplicates write roots", () => {
  const rules = toolPolicyToRuleSet({
    writeRoots: ["/tmp/project/", "/tmp/project", "/tmp/other/../project"],
  });
  assert.deepEqual(rules.writeRoots, ["/tmp/project"]);
});

test("toolPolicyToRuleSet keeps the exclusive allow list semantics", () => {
  assert.equal(toolPolicyToRuleSet({}).allowList, undefined);
  assert.deepEqual(toolPolicyToRuleSet({ allow: [] }).allowList, []);
});
