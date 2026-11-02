import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import ProjectTeamSection from "./index";

const mocks = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("../../../../utils/api", () => ({ authenticatedFetch: mocks.fetch }));
// ModelPanel 从模型库（PilotDeckConfig）读可选模型，这里给一份最小配置，
// 免得测试去依赖真实的配置 provider。
vi.mock("../../../../hooks/usePilotDeckConfig", () => ({
  usePilotDeckConfig: () => ({
    raw: "model:\n  providers:\n    openai:\n      models:\n        gpt-4o: {}\n",
    loading: false,
  }),
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en" } }),
}));

afterEach(() => {
  cleanup();
  mocks.fetch.mockReset();
});

const projects = [{ name: "demo", fullPath: "/tmp/demo" }];

const agentFixture = {
  id: "agent-1",
  name: "Reviewer One",
  description: "检查改动",
  role: "reviewer",
  roleDefinition: "只看，不改",
  model: null,
  enabled: true,
  permissions: {
    toolAccess: "all",
    allowedTools: [],
    deniedTools: [],
    network: "ask",
    writeScope: "project",
    requireApproval: true,
  },
  reportsTo: null,
};

const loadPayload = {
  version: 1,
  revision: "rev-1",
  collaboration: { mode: "manual" },
  agents: [agentFixture],
};

const savePayload = {
  version: 1,
  revision: "rev-2",
  collaboration: { mode: "manual" },
  agents: [agentFixture],
};

function jsonResponse(
  body: unknown,
  init: { ok?: boolean; status?: number } = {},
): Response {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    json: async () => body,
  } as unknown as Response;
}

function renderSection() {
  // ProjectTeamSection 用 useSearchParams 读 projectRoot，渲染必须带 Router。
  return render(
    <MemoryRouter initialEntries={["/settings?projectRoot=/tmp/demo"]}>
      <ProjectTeamSection title="Project Team" projects={projects} />
    </MemoryRouter>,
  );
}

function requestBody(callIndex: number): Record<string, any> {
  const [, options] = mocks.fetch.mock.calls[callIndex] as [string, RequestInit];
  return JSON.parse(String(options.body)) as Record<string, any>;
}

it("loads the team configuration for the selected project", async () => {
  mocks.fetch.mockResolvedValue(jsonResponse(loadPayload));

  renderSection();

  await waitFor(() => expect(mocks.fetch).toHaveBeenCalled());
  expect(mocks.fetch.mock.calls[0][0]).toBe(
    "/api/project-team?projectRoot=%2Ftmp%2Fdemo",
  );
  expect(mocks.fetch.mock.calls[0][1]).toMatchObject({ method: "GET" });
});

it("saves the team with the fields the backend expects", async () => {
  mocks.fetch
    .mockResolvedValueOnce(jsonResponse(loadPayload))
    .mockResolvedValueOnce(jsonResponse(savePayload));

  renderSection();
  await waitFor(() => expect(mocks.fetch).toHaveBeenCalledTimes(1));

  fireEvent.click(screen.getByRole("button", { name: "actions.addAgent" }));
  fireEvent.click(screen.getByRole("button", { name: "actions.save" }));

  await waitFor(() => expect(mocks.fetch).toHaveBeenCalledTimes(2));
  const [url, options] = mocks.fetch.mock.calls[1] as [string, RequestInit];
  expect(url).toBe("/api/project-team?projectRoot=%2Ftmp%2Fdemo");
  expect(options.method).toBe("PUT");

  const body = JSON.parse(String(options.body));
  expect(Object.keys(body).sort()).toEqual([
    "agents",
    "collaboration",
    "revision",
    "version",
  ]);
  expect(body.version).toBe(1);
  expect(body.revision).toBe("rev-1");
  expect(body.collaboration).toEqual({ mode: "manual" });
  expect(body.agents).toHaveLength(2);
  expect(Object.keys(body.agents[1]).sort()).toEqual([
    "description",
    "enabled",
    "id",
    "model",
    "name",
    "permissions",
    "reportsTo",
    "role",
    "roleDefinition",
  ]);
  expect(Object.keys(body.agents[1].permissions).sort()).toEqual([
    "allowedTools",
    "deniedTools",
    "network",
    "requireApproval",
    "toolAccess",
    "writeScope",
  ]);
});

it("warns about a stale revision and offers a reload when the save conflicts", async () => {
  mocks.fetch
    .mockResolvedValueOnce(jsonResponse(loadPayload))
    .mockResolvedValueOnce(
      jsonResponse({ error: "stale revision" }, { ok: false, status: 409 }),
    );

  renderSection();
  await waitFor(() => expect(mocks.fetch).toHaveBeenCalledTimes(1));

  fireEvent.click(screen.getByRole("button", { name: "actions.addAgent" }));
  fireEvent.click(screen.getByRole("button", { name: "actions.save" }));

  await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
  expect(screen.getByRole("alert").textContent).toContain("conflict");
  expect(
    screen.getAllByRole("button", { name: "actions.reload" }).length,
  ).toBeGreaterThanOrEqual(2);
});

it("shows an empty state when no project is registered", async () => {
  // 没有 projectRoot 查询参数：既没有可选项目，也不该发出任何请求。
  render(
    <MemoryRouter initialEntries={["/settings"]}>
      <ProjectTeamSection title="Project Team" projects={[]} />
    </MemoryRouter>,
  );

  await waitFor(() => expect(screen.getByText("noProjects")).toBeTruthy());
  expect(mocks.fetch).not.toHaveBeenCalled();
});

it("clears reportsTo of the remaining agents when an agent is removed", async () => {
  const teamPayload = {
    version: 1,
    revision: "rev-1",
    collaboration: { mode: "manual" },
    agents: [
      { ...agentFixture, id: "agent-1", name: "Commander", role: "commander" },
      {
        ...agentFixture,
        id: "agent-2",
        name: "Executor",
        role: "executor",
        reportsTo: "agent-1",
      },
    ],
  };

  mocks.fetch
    .mockResolvedValueOnce(jsonResponse(teamPayload))
    .mockResolvedValueOnce(jsonResponse(savePayload));

  renderSection();
  await waitFor(() => expect(mocks.fetch).toHaveBeenCalledTimes(1));

  // 成员列表里第一个就是 agent-1（它的 remove 按钮 aria-label 是同一个 key）。
  const removeButtons = screen.getAllByRole("button", {
    name: "actions.removeAgent",
  });
  expect(removeButtons.length).toBeGreaterThanOrEqual(2);
  fireEvent.click(removeButtons[0]);

  const dialog = screen.getByRole("dialog");
  fireEvent.click(
    within(dialog).getByRole("button", { name: "actions.removeAgent" }),
  );

  await waitFor(() =>
    expect(
      screen.queryAllByRole("button", { name: "actions.removeAgent" }),
    ).toHaveLength(1),
  );

  fireEvent.click(screen.getByRole("button", { name: "actions.save" }));

  await waitFor(() => expect(mocks.fetch).toHaveBeenCalledTimes(2));
  const body = requestBody(1);
  expect(body.agents).toHaveLength(1);
  expect(body.agents[0].id).toBe("agent-2");
  // 被删掉的 agent-1 不再存在，reportsTo 必须一起清掉，否则后端会 400。
  expect(body.agents[0].reportsTo).toBeNull();
});

it("selects and saves a model from the connected model library", async () => {
  mocks.fetch.mockResolvedValueOnce(jsonResponse(loadPayload)).mockResolvedValueOnce(jsonResponse(savePayload));
  renderSection();
  await waitFor(() => expect(mocks.fetch).toHaveBeenCalledTimes(1));
  fireEvent.click(screen.getByRole("tab", { name: "tabs.model" }));
  fireEvent.change(screen.getByLabelText("model.followSession"), { target: { value: "custom-model" } });
  fireEvent.change(screen.getByLabelText("model.model"), { target: { value: "openai/gpt-4o" } });
  fireEvent.click(screen.getByRole("button", { name: "actions.save" }));
  await waitFor(() => expect(mocks.fetch).toHaveBeenCalledTimes(2));
  expect(requestBody(1).agents[0].model).toEqual({provider:'openai', model:'gpt-4o'});
});

it("blocks the save when the custom model is incomplete", async () => {
  mocks.fetch.mockResolvedValue(jsonResponse(loadPayload));

  renderSection();
  await waitFor(() => expect(mocks.fetch).toHaveBeenCalledTimes(1));

  fireEvent.click(screen.getByRole("tab", { name: "tabs.model" }));
  fireEvent.change(screen.getByLabelText("model.followSession"), {
    target: { value: "custom-model" },
  });

  fireEvent.click(screen.getByRole("button", { name: "actions.save" }));

  await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
  expect(screen.getByRole("alert").textContent).toContain("model provider");
  // 校验没过就不应该发出 PUT。
  expect(mocks.fetch).toHaveBeenCalledTimes(1);
});

it("sends the selected collaboration mode in the save payload", async () => {
  mocks.fetch
    .mockResolvedValueOnce(jsonResponse(loadPayload))
    .mockResolvedValueOnce(jsonResponse(savePayload));

  renderSection();
  await waitFor(() => expect(mocks.fetch).toHaveBeenCalledTimes(1));

  fireEvent.click(screen.getByRole("tab", { name: "tabs.collaboration" }));
  fireEvent.change(screen.getByLabelText("collaboration.modes.manual"), {
    target: { value: "commander" },
  });

  fireEvent.click(screen.getByRole("button", { name: "actions.save" }));

  await waitFor(() => expect(mocks.fetch).toHaveBeenCalledTimes(2));
  expect(requestBody(1).collaboration).toEqual({ mode: "commander" });
});

it("rejects an invalid tool entry before sending the save request", async () => {
  mocks.fetch.mockResolvedValue(jsonResponse(loadPayload));

  renderSection();
  await waitFor(() => expect(mocks.fetch).toHaveBeenCalledTimes(1));

  fireEvent.click(screen.getByRole("tab", { name: "tabs.tools" }));
  fireEvent.click(
    screen.getAllByRole("button", { name: "tools.addEntry" })[0],
  );
  fireEvent.change(screen.getByLabelText("tools.entryLabel"), {
    target: { value: "not a valid tool!" },
  });

  fireEvent.click(screen.getByRole("button", { name: "actions.save" }));

  await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
  expect(screen.getByRole("alert").textContent).toContain("invalidTools");
  expect(mocks.fetch).toHaveBeenCalledTimes(1);
});

it("saves against the absolute project path", async () => {
  mocks.fetch
    .mockResolvedValueOnce(jsonResponse(loadPayload))
    .mockResolvedValueOnce(jsonResponse(savePayload));

  renderSection();
  await waitFor(() => expect(mocks.fetch).toHaveBeenCalledTimes(1));

  fireEvent.click(screen.getByRole("button", { name: "actions.save" }));

  await waitFor(() => expect(mocks.fetch).toHaveBeenCalledTimes(2));
  const [url] = mocks.fetch.mock.calls[1] as [string, RequestInit];
  expect(url.startsWith("/api/project-team?projectRoot=")).toBe(true);
  expect(decodeURIComponent(url.split("projectRoot=")[1])).toBe("/tmp/demo");
});

it("asks before reloading when there are unsaved changes", async () => {
  mocks.fetch.mockResolvedValue(jsonResponse(loadPayload));

  renderSection();
  await waitFor(() => expect(mocks.fetch).toHaveBeenCalledTimes(1));

  // 新增 Agent 会让草稿与已保存配置产生差异。
  fireEvent.click(screen.getByRole("button", { name: "actions.addAgent" }));
  fireEvent.click(screen.getByRole("button", { name: "actions.reload" }));

  const dialog = screen.getByRole("dialog");
  expect(dialog.textContent).toContain("unsaved changes");
  // 还没确认之前不应该重新拉取。
  expect(mocks.fetch).toHaveBeenCalledTimes(1);

  fireEvent.click(
    within(dialog).getByRole("button", { name: "actions.reload" }),
  );

  await waitFor(() => expect(mocks.fetch).toHaveBeenCalledTimes(2));
});
