import { expect, it } from "vitest";
import {
  createProjectTeamAgent,
  DEFAULT_PROJECT_AGENT_PERMISSIONS,
  PROJECT_TEAM_MAX_TOOL_ENTRIES,
  validateProjectTeamDraft,
  type ProjectTeamAgent,
} from "../../../../lib/projectTeam";
import {
  describeDraftIssue,
  describeToolLimitReached,
  type ProjectTeamDraftIssue,
} from "./validationMessages";

function toolEntries(count: number, prefix = "tool"): string[] {
  return Array.from({ length: count }, (_, index) => `${prefix}_${index}`);
}

function agentWithToolLists(
  allowedTools: string[],
  deniedTools: string[],
): ProjectTeamAgent {
  return createProjectTeamAgent("executor", {
    id: "agent-1",
    name: "Executor",
    permissions: {
      ...DEFAULT_PROJECT_AGENT_PERMISSIONS,
      toolAccess: "allow-list",
      allowedTools,
      deniedTools,
    },
  });
}

function tooManyEntries(
  list: "allowedTools" | "deniedTools",
): ProjectTeamDraftIssue {
  return {
    kind: "tooManyToolEntries",
    index: 0,
    max: PROJECT_TEAM_MAX_TOOL_ENTRIES,
    list,
  };
}

it("names allowedTools when the allow list exceeds the per-list limit", () => {
  const message = describeDraftIssue(tooManyEntries("allowedTools"), "en");

  expect(message).toContain("allowedTools");
  expect(message).not.toContain("deniedTools");
  expect(message).toContain(String(PROJECT_TEAM_MAX_TOOL_ENTRIES));
});

it("names deniedTools when the deny list exceeds the per-list limit", () => {
  const message = describeDraftIssue(tooManyEntries("deniedTools"), "en");

  expect(message).toContain("deniedTools");
  expect(message).not.toContain("allowedTools");
  expect(message).toContain(String(PROJECT_TEAM_MAX_TOOL_ENTRIES));
});

it("names the offending list in Chinese too", () => {
  const allowed = describeDraftIssue(tooManyEntries("allowedTools"), "zh-CN");
  expect(allowed).toContain("allowedTools");
  expect(allowed).toContain("允许列表");
  expect(allowed).not.toContain("deniedTools");
  expect(allowed).not.toContain("禁止列表");

  const denied = describeDraftIssue(tooManyEntries("deniedTools"), "zh-CN");
  expect(denied).toContain("deniedTools");
  expect(denied).toContain("禁止列表");
  expect(denied).not.toContain("allowedTools");
  expect(denied).not.toContain("允许列表");
});

it("reports the list that broke the limit through the draft validation", () => {
  const tooManyAllowed = validateProjectTeamDraft([
    agentWithToolLists(toolEntries(PROJECT_TEAM_MAX_TOOL_ENTRIES + 1), []),
  ]);
  expect(tooManyAllowed.ok).toBe(false);
  if (tooManyAllowed.ok) return;
  expect(tooManyAllowed.issue.kind).toBe("tooManyToolEntries");
  if (tooManyAllowed.issue.kind !== "tooManyToolEntries") return;
  expect(tooManyAllowed.issue.list).toBe("allowedTools");
  expect(describeDraftIssue(tooManyAllowed.issue, "en")).toContain(
    "allowedTools",
  );

  const tooManyDenied = validateProjectTeamDraft([
    agentWithToolLists(
      toolEntries(PROJECT_TEAM_MAX_TOOL_ENTRIES),
      toolEntries(PROJECT_TEAM_MAX_TOOL_ENTRIES + 1, "denied"),
    ),
  ]);
  expect(tooManyDenied.ok).toBe(false);
  if (tooManyDenied.ok) return;
  expect(tooManyDenied.issue.kind).toBe("tooManyToolEntries");
  if (tooManyDenied.issue.kind !== "tooManyToolEntries") return;
  expect(tooManyDenied.issue.list).toBe("deniedTools");
  expect(describeDraftIssue(tooManyDenied.issue, "en")).toContain("deniedTools");
});

it("accepts both lists holding the maximum at the same time", () => {
  const result = validateProjectTeamDraft([
    agentWithToolLists(
      toolEntries(PROJECT_TEAM_MAX_TOOL_ENTRIES),
      toolEntries(PROJECT_TEAM_MAX_TOOL_ENTRIES, "denied"),
    ),
  ]);

  expect(result.ok).toBe(true);
});

it("describes the add-entry limit as a per-list limit", () => {
  const english = describeToolLimitReached("en");
  expect(english).toMatch(/each (tool )?list/i);
  expect(english).toContain(String(PROJECT_TEAM_MAX_TOOL_ENTRIES));

  const chinese = describeToolLimitReached("zh-CN");
  expect(chinese).toContain("列表");
  expect(chinese).toContain(String(PROJECT_TEAM_MAX_TOOL_ENTRIES));
});
