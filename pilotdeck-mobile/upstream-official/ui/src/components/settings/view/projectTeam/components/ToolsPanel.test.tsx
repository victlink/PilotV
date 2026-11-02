import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import {
  DEFAULT_PROJECT_AGENT_PERMISSIONS,
  PROJECT_TEAM_MAX_TOOL_ENTRIES,
  createProjectTeamAgent,
  type ProjectTeamAgent,
} from "../../../../../lib/projectTeam";
import ToolsPanel from "./ToolsPanel";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en" } }),
}));

afterEach(() => {
  cleanup();
});

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

function renderToolsPanel(agent: ProjectTeamAgent) {
  const onChangeAgent = vi.fn();
  render(
    <ToolsPanel
      agents={[agent]}
      selectedAgentId={agent.id}
      onSelectAgent={() => {}}
      onChangeAgent={onChangeAgent}
    />,
  );
  return { onChangeAgent };
}

function addButtons(): HTMLButtonElement[] {
  return screen.getAllByRole("button", { name: "tools.addEntry" }) as HTMLButtonElement[];
}

it("keeps the deny list editable when the allow list already holds the maximum", () => {
  const agent = agentWithToolLists(
    toolEntries(PROJECT_TEAM_MAX_TOOL_ENTRIES),
    [],
  );

  renderToolsPanel(agent);

  const buttons = addButtons();
  expect(buttons).toHaveLength(2);
  // 白名单自己写满了 200 条，白名单的"添加"按钮必须禁用。
  expect(buttons[0].disabled).toBe(true);
  // 黑名单是独立的列表，后端对它单独限制 200 条，所以还能继续添加。
  expect(buttons[1].disabled).toBe(false);
});

it("keeps the allow list editable when the deny list already holds the maximum", () => {
  const agent = agentWithToolLists(
    [],
    toolEntries(PROJECT_TEAM_MAX_TOOL_ENTRIES, "denied"),
  );

  renderToolsPanel(agent);

  const buttons = addButtons();
  expect(buttons).toHaveLength(2);
  expect(buttons[0].disabled).toBe(false);
  expect(buttons[1].disabled).toBe(true);
});

it("explains on the disabled add button that the limit applies per list", () => {
  const agent = agentWithToolLists(
    toolEntries(PROJECT_TEAM_MAX_TOOL_ENTRIES),
    [],
  );

  renderToolsPanel(agent);

  const buttons = addButtons();
  expect(buttons[0].disabled).toBe(true);
  expect(buttons[0].title).toMatch(/each (tool )?list/i);
  expect(buttons[0].title).toContain(String(PROJECT_TEAM_MAX_TOOL_ENTRIES));
});

it("adds an entry to the list that still has room", () => {
  const agent = agentWithToolLists(
    toolEntries(PROJECT_TEAM_MAX_TOOL_ENTRIES),
    [],
  );

  const { onChangeAgent } = renderToolsPanel(agent);

  fireEvent.click(addButtons()[1]);

  expect(onChangeAgent).toHaveBeenCalledTimes(1);
  const [agentId, patch] = onChangeAgent.mock.calls[0] as [
    string,
    Partial<ProjectTeamAgent>,
  ];
  expect(agentId).toBe("agent-1");
  expect(patch.permissions?.deniedTools).toEqual([""]);
  expect(patch.permissions?.allowedTools).toHaveLength(
    PROJECT_TEAM_MAX_TOOL_ENTRIES,
  );
});
