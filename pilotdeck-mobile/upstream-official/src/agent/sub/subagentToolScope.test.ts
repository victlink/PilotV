import test from "node:test";
import assert from "node:assert/strict";

import { isToolAllowedForSubagent } from "./subagentToolScope.js";
import { SUBAGENT_DEFINITIONS } from "./builtinSubagentTypes.js";

const GENERAL = { allowedTools: ["*"] };
const EXPLORE = { allowedTools: ["read_file", "grep", "glob", "bash", "ask_user_question"] };
const WITH_CHANNEL = { hasElicitationChannel: true };
const NO_CHANNEL = { hasElicitationChannel: false };

test("scoping: the hard exclusions hold for every preset", () => {
  for (const definition of [GENERAL, EXPLORE]) {
    for (const tool of ["agent", "enter_plan_mode", "exit_plan_mode", "always_on_run_create"]) {
      assert.equal(
        isToolAllowedForSubagent(tool, definition, WITH_CHANNEL),
        false,
        `${tool} must never reach a subagent (preset ${definition.allowedTools.join("|")})`,
      );
    }
  }
});

test("scoping: nested forks are removed from the registry, not only depth-capped", () => {
  // The depth cap is the backstop; removing the tool is what stops the model
  // from attempting it and burning a turn on a guaranteed error.
  assert.equal(isToolAllowedForSubagent("agent", GENERAL, WITH_CHANNEL), false);
});

test("scoping: ask_user_question follows the channel, not the preset", () => {
  assert.equal(isToolAllowedForSubagent("ask_user_question", GENERAL, WITH_CHANNEL), true);
  // With no channel there is nowhere to route the question; advertising the
  // tool would only produce a guaranteed failure at call time.
  assert.equal(isToolAllowedForSubagent("ask_user_question", GENERAL, NO_CHANNEL), false);
  assert.equal(isToolAllowedForSubagent("ask_user_question", EXPLORE, NO_CHANNEL), false);
});

test("scoping: a read-only preset still cannot write", () => {
  assert.equal(isToolAllowedForSubagent("edit_file", EXPLORE, WITH_CHANNEL), false);
  assert.equal(isToolAllowedForSubagent("write_file", EXPLORE, WITH_CHANNEL), false);
  assert.equal(isToolAllowedForSubagent("read_file", EXPLORE, WITH_CHANNEL), true);
});

test("read-only presets list ask_user_question, and nothing writable crept in", () => {
  const readOnly = Object.values(SUBAGENT_DEFINITIONS).filter((d) => d.isReadOnly);
  assert.ok(readOnly.length >= 3, "expected explore/plan/verify to be read-only");
  for (const definition of readOnly) {
    assert.ok(
      definition.allowedTools.includes("ask_user_question"),
      `${definition.id}: a read-only subagent that cannot ask will guess instead`,
    );
    for (const writable of ["edit_file", "write_file", "bash_write", "execute_code"]) {
      assert.equal(definition.allowedTools.includes(writable), false, `${definition.id} gained ${writable}`);
    }
    assert.equal(definition.allowedTools.includes("agent"), false, `${definition.id} gained nested forking`);
  }
});

test("general-purpose keeps wildcard access", () => {
  const general = SUBAGENT_DEFINITIONS["general-purpose"];
  assert.ok(general, "general-purpose preset must exist");
  assert.deepEqual([...general.allowedTools], ["*"]);
  assert.equal(isToolAllowedForSubagent("edit_file", general, WITH_CHANNEL), true);
});