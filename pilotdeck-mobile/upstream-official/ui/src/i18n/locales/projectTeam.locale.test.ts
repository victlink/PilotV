import { expect, it } from "vitest";
import en from "./en/projectTeam.json";
import zh from "./zh-CN/projectTeam.json";

/**
 * 写入范围的提示必须说清楚「项目内可写」是硬性边界：
 * 后端 `buildProjectAgentToolPolicy` 把无法限定路径的写入工具直接 deny，
 * 而不是 ask，所以提示不能暗示"问一句就能写出去"。
 */
it("describes the project write scope as a hard boundary in English", () => {
  const hint = en.tools.writeScopeHint;

  expect(hint).toContain(en.tools.writeScopes.project);
  expect(hint).toMatch(/hard boundary/i);
  expect(hint).toMatch(/denied/i);
});

it("describes the project write scope as a hard boundary in Chinese", () => {
  const hint = zh.tools.writeScopeHint;

  expect(hint).toContain(zh.tools.writeScopes.project);
  expect(hint).toContain("硬性边界");
  expect(hint).toContain("拒绝");
});
