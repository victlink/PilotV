import {
  act,
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
  localStorage.clear();
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

it("copies a reusable inspector definition without overwriting the template or binding identity", async () => {
  mocks.fetch.mockResolvedValue(jsonResponse(loadPayload));
  const view = renderSection();
  await screen.findByText("Reviewer One");
  fireEvent.click(screen.getByRole("tab", { name: "tabs.roles" }));
  const choose = (value: string) => fireEvent.change(screen.getByLabelText("templates.choose"), { target: { value } });
  const definition = () => screen.getByLabelText("templates.definition") as HTMLTextAreaElement;
  choose("builtin:inspector");
  const builtin = definition().value;
  expect(builtin).toMatch(/inspect/i);
  fireEvent.change(definition(), { target: { value: "Inspect deployment health" } });
  fireEvent.change(screen.getByLabelText("templates.name"), { target: { value: "Health checks" } });
  fireEvent.click(screen.getByRole("button", { name: "templates.saveAs" }));
  expect(mocks.fetch).toHaveBeenCalledTimes(1);
  view.unmount();

  renderSection();
  await screen.findByText("Reviewer One");
  fireEvent.click(screen.getByRole("tab", { name: "tabs.roles" }));
  const saved = screen.getByRole<HTMLOptionElement>("option", { name: "Health checks" });
  choose(saved.value);
  expect(definition().value).toBe("Inspect deployment health");
  fireEvent.click(screen.getByRole("button", { name: "templates.apply" }));
  fireEvent.click(screen.getByRole("button", { name: "actions.save" }));
  await waitFor(() => expect(mocks.fetch).toHaveBeenCalledTimes(3));
  expect(requestBody(2).agents).toEqual([expect.objectContaining({
    id: "agent-1", name: "Reviewer One", role: "reviewer",
    description: "Independently inspect project health and operational risks",
    roleDefinition: "Inspect deployment health", permissions: agentFixture.permissions,
  })]);
  expect(requestBody(2)).not.toHaveProperty("templates");
  choose(saved.value);
  fireEvent.click(screen.getByRole("button", { name: "templates.restore" }));
  expect(definition().value).toBe(builtin);
  expect(screen.getByRole("option", { name: "Health checks" })).toBeTruthy();
});

it("requires confirmation before changing the member role and preserves custom text and permissions", async () => {
  mocks.fetch.mockResolvedValue(jsonResponse(loadPayload));
  renderSection();
  await screen.findByText("Reviewer One");
  fireEvent.click(screen.getByRole("tab", { name: "tabs.roles" }));
  const memberRole = screen.getByRole<HTMLSelectElement>("combobox", { name: "roles.reviewer" });

  fireEvent.change(memberRole, { target: { value: "executor" } });
  expect(memberRole.value).toBe("reviewer");
  let dialog = within(screen.getByRole("dialog"));
  expect(dialog.getByText("roles.changeConfirm")).toBeTruthy();
  fireEvent.click(dialog.getByRole("button", { name: "confirmDialog.cancel" }));
  expect(memberRole.value).toBe("reviewer");
  expect(screen.queryByRole("dialog")).toBeNull();

  fireEvent.change(memberRole, { target: { value: "executor" } });
  dialog = within(screen.getByRole("dialog"));
  fireEvent.click(dialog.getByRole("button", { name: "roles.changeAction" }));
  expect(memberRole.value).toBe("executor");
  fireEvent.click(screen.getByRole("button", { name: "actions.save" }));
  await waitFor(() => expect(mocks.fetch).toHaveBeenCalledTimes(2));
  expect(requestBody(1).agents).toEqual([{ ...agentFixture, role: "executor" }]);
});

it("keeps simultaneous same-name saves when the second tab writes between the first tab read and write", async () => {
  mocks.fetch.mockResolvedValue(jsonResponse(loadPayload));
  const first = renderSection();
  await within(first.container).findByText("Reviewer One");
  fireEvent.click(within(first.container).getByRole("tab", { name: "tabs.roles" }));
  const second = renderSection();
  await within(second.container).findByText("Reviewer One");
  fireEvent.click(within(second.container).getByRole("tab", { name: "tabs.roles" }));

  for (const [view, definition] of [[first, "First definition"], [second, "Second definition"]] as const) {
    const editor = within(view.container);
    fireEvent.change(editor.getByLabelText("templates.definition"), { target: { value: definition } });
    fireEvent.change(editor.getByLabelText("templates.name"), { target: { value: "Shared name" } });
  }

  // Suspend the first write after its read; the other tab completes a save before it resumes.
  // Unlike two sequential clicks, this deterministically exercises the lost-update window.
  const originalSetItem = Storage.prototype.setItem;
  let interleaved = false;
  const write = vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, key, value) {
    if (!interleaved && key.startsWith("pilotdeck.projectTeam.roleTemplates.")) {
      interleaved = true;
      fireEvent.click(within(second.container).getByRole("button", { name: "templates.saveAs" }));
    }
    originalSetItem.call(this, key, value);
  });
  try {
    fireEvent.click(within(first.container).getByRole("button", { name: "templates.saveAs" }));
    expect(interleaved).toBe(true);
  } finally {
    write.mockRestore();
  }

  first.unmount();
  second.unmount();
  renderSection();
  await screen.findByText("Reviewer One");
  fireEvent.click(screen.getByRole("tab", { name: "tabs.roles" }));
  const copies = screen.getAllByRole<HTMLOptionElement>("option", { name: "Shared name" });
  expect(copies).toHaveLength(2);
  const definitions = copies.map(({ value }) => {
    fireEvent.change(screen.getByLabelText("templates.choose"), { target: { value } });
    return screen.getByLabelText<HTMLTextAreaElement>("templates.definition").value;
  });
  expect(definitions.sort()).toEqual(["First definition", "Second definition"]);
});

it("refreshes same-origin templates without changing the selected template when the list is reordered", async () => {
  const key = "pilotdeck.projectTeam.roleTemplates.v1";
  const legacy = { role: "inspector", name: "Legacy copy", description: "Duty", roleDefinition: "Legacy definition" };
  const first = { ...legacy, id: "first", name: "First", roleDefinition: "First definition" };
  const second = { ...legacy, id: "second", name: "Second", roleDefinition: "Second definition" };
  localStorage.setItem(key, JSON.stringify([legacy, first, second]));
  mocks.fetch.mockResolvedValue(jsonResponse(loadPayload));
  renderSection();
  await screen.findByText("Reviewer One");
  fireEvent.click(screen.getByRole("tab", { name: "tabs.roles" }));
  const choose = screen.getByLabelText<HTMLSelectElement>("templates.choose");
  expect(screen.getByRole("option", { name: "Legacy copy" })).toBeTruthy();
  fireEvent.change(choose, { target: { value: screen.getByRole<HTMLOptionElement>("option", { name: "First" }).value } });
  const newValue = JSON.stringify([second, first]);
  localStorage.setItem(key, newValue);
  act(() => window.dispatchEvent(new StorageEvent("storage", { key, newValue, storageArea: localStorage })));
  expect(screen.queryByRole("option", { name: "Legacy copy" })).toBeNull();
  expect(choose.selectedOptions[0].textContent).toBe("First");
  expect(screen.getByLabelText<HTMLTextAreaElement>("templates.definition").value).toBe("First definition");
});

it("preserves identical legacy copies across saving and remount without rewriting the legacy table", async () => {
  const key = "pilotdeck.projectTeam.roleTemplates.v1";
  const legacy = { role: "inspector", name: "Legacy", description: "Duty", roleDefinition: "Old definition" };
  const original = JSON.stringify([legacy, legacy]);
  localStorage.setItem(key, original);
  mocks.fetch.mockResolvedValue(jsonResponse(loadPayload));
  const view = renderSection();
  await screen.findByText("Reviewer One");
  fireEvent.click(screen.getByRole("tab", { name: "tabs.roles" }));
  const copies = screen.getAllByRole<HTMLOptionElement>("option", { name: "Legacy" });
  expect(copies).toHaveLength(2);
  expect(copies[0].value).not.toBe(copies[1].value);
  fireEvent.change(screen.getByLabelText("templates.choose"), { target: { value: copies[0].value } });
  fireEvent.change(screen.getByLabelText("templates.name"), { target: { value: "New copy" } });
  fireEvent.click(screen.getByRole("button", { name: "templates.saveAs" }));
  expect(localStorage.getItem(key)).toBe(original);
  view.unmount();
  renderSection();
  await screen.findByText("Reviewer One");
  fireEvent.click(screen.getByRole("tab", { name: "tabs.roles" }));
  expect(screen.getAllByRole("option", { name: "Legacy" })).toHaveLength(2);
  fireEvent.change(screen.getByLabelText("templates.choose"), {
    target: { value: screen.getByRole<HTMLOptionElement>("option", { name: "New copy" }).value },
  });
  expect(screen.getByLabelText<HTMLTextAreaElement>("templates.definition").value).toBe("Old definition");
});

it("subscribes to per-ID additions and deletion and resets a deleted selection", async () => {
  mocks.fetch.mockResolvedValue(jsonResponse(loadPayload));
  renderSection();
  await screen.findByText("Reviewer One");
  fireEvent.click(screen.getByRole("tab", { name: "tabs.roles" }));
  const key = "pilotdeck.projectTeam.roleTemplates.v2:remote";
  const value = JSON.stringify({ id: "remote", role: "inspector", name: "Remote", description: "Duty", roleDefinition: "Remote definition" });
  localStorage.setItem(key, value);
  act(() => window.dispatchEvent(new StorageEvent("storage", { key, newValue: value, storageArea: localStorage })));
  fireEvent.change(screen.getByLabelText("templates.choose"), {
    target: { value: screen.getByRole<HTMLOptionElement>("option", { name: "Remote" }).value },
  });
  expect(screen.getByLabelText<HTMLTextAreaElement>("templates.definition").value).toBe("Remote definition");
  localStorage.removeItem(key);
  act(() => window.dispatchEvent(new StorageEvent("storage", { key, newValue: null, storageArea: localStorage })));
  expect(screen.queryByRole("option", { name: "Remote" })).toBeNull();
  expect(screen.getByLabelText<HTMLSelectElement>("templates.choose").value).toBe("builtin:executor");
});

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
