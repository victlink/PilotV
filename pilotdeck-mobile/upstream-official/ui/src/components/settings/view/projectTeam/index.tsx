import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Loader2 } from "lucide-react";
import { ConfirmDialog } from "../../../ui/ConfirmDialog";
import {
  fetchProjectTeam,
  ProjectTeamConflictError,
  saveProjectTeam,
} from "../../../../lib/projectTeamApi";
import {
  createProjectTeamAgent,
  isProjectTeamDraftDirty,
  isValidToolEntry,
  PROJECT_TEAM_MAX_AGENTS,
  validateProjectTeamDraft,
  type ProjectTeamAgent,
  type ProjectTeamCollaboration,
  type ProjectTeamConfig,
} from "../../../../lib/projectTeam";
import type { SettingsProject } from "../../shared/types";
import { getAlwaysOnProjectRoot } from "../../shared/utils/alwaysOnConfigPatch";
import { FieldSaveModeProvider } from "../../shared/components/Inputs";
import { PageSectionHeader } from "../../shared/view";
import { showSettingsSuccess } from "../../shared/SettingsSuccessToast";
import CollaborationPanel from "./components/CollaborationPanel";
import MembersPanel from "./components/MembersPanel";
import ModelPanel from "./components/ModelPanel";
import ProjectToolbar from "./components/ProjectToolbar";
import RolePanel from "./components/RolePanel";
import TeamTabs from "./components/TeamTabs";
import ToolsPanel from "./components/ToolsPanel";
import { getDefaultAgentTemplate } from "./roleLabels";
import {
  describeAgentLimitReached,
  describeDraftIssue,
  describeUnsavedChanges,
  resolveProjectTeamLocale,
} from "./validationMessages";
import type { TeamTabKey } from "./types";

const EMPTY_PROJECTS: SettingsProject[] = [];

/**
 * 设置页通用的 `SettingsProject` 没有 `kind` 字段，但通用工作区
 * （`kind === 'general'`）不能配置项目团队——后端会直接跳过它们。
 * 这里在本地补一个可选字段，避免改动共享类型。
 */
type TeamProject = SettingsProject & { kind?: "project" | "general" };

type ProjectTeamSectionProps = {
  title?: string;
  projects?: TeamProject[];
};

export function ProjectTeamSection({
  title,
  projects = EMPTY_PROJECTS,
}: ProjectTeamSectionProps) {
  const { t, i18n } = useTranslation("projectTeam");
  const locale = resolveProjectTeamLocale(i18n?.language);
  const [searchParams] = useSearchParams();
  const requestedProjectRoot = searchParams.get("projectRoot") ?? "";
  const [projectRoot, setProjectRoot] = useState(requestedProjectRoot);
  const [config, setConfig] = useState<ProjectTeamConfig | null>(null);
  const [draftAgents, setDraftAgents] = useState<ProjectTeamAgent[]>([]);
  const [draftCollaboration, setDraftCollaboration] =
    useState<ProjectTeamCollaboration>({ mode: "manual" });
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<TeamTabKey>("members");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [pendingRemovalId, setPendingRemovalId] = useState<string | null>(null);
  const [pendingReload, setPendingReload] = useState(false);

  // 请求序号：只有最后一次 load 的响应才允许写回状态。
  const loadSeqRef = useRef(0);
  const loadAbortRef = useRef<AbortController | null>(null);
  const saveSeqRef = useRef(0);
  // 当前选中的项目。保存期间用它判断"响应是否还属于当前项目"。
  const projectRootRef = useRef(projectRoot);
  projectRootRef.current = projectRoot;

  const projectOptions = useMemo(
    () =>
      projects
        // 通用工作区不是项目，后端不会为它保存团队配置。
        .filter((project) => project.kind !== "general")
        .map((project) => {
          const value = getAlwaysOnProjectRoot(project);
          const label =
            (project.displayName || project.name || "").trim() || value;
          return { label, value };
        })
        .filter((option) => option.value.length > 0),
    [projects],
  );

  const appliedRequestedRoot = useRef<string | null>(null);
  // Apply a deep link once; later manual project changes remain possible.
  useEffect(() => {
    if (requestedProjectRoot && appliedRequestedRoot.current !== requestedProjectRoot && projectOptions.some((option) => option.value === requestedProjectRoot)) {
      appliedRequestedRoot.current = requestedProjectRoot;
      setProjectRoot(requestedProjectRoot);
    } else if (!projectRoot && projectOptions[0]) {
      setProjectRoot(projectOptions[0].value);
    }
  }, [projectOptions, projectRoot, requestedProjectRoot]);

  const load = useCallback(async () => {
    const seq = ++loadSeqRef.current;
    // 中断上一次还没返回的请求，避免旧项目的响应覆盖新项目。
    loadAbortRef.current?.abort();
    const controller =
      typeof AbortController === "undefined" ? null : new AbortController();
    loadAbortRef.current = controller;

    if (!projectRoot) {
      setConfig(null);
      setDraftAgents([]);
      setDraftCollaboration({ mode: "manual" });
      setSelectedAgentId(null);
      setLoading(false);
      return;
    }

    // 先清空上一个项目的数据，避免切换项目时短暂看到旧内容。
    setConfig(null);
    setDraftAgents([]);
    setDraftCollaboration({ mode: "manual" });
    setSelectedAgentId(null);
    setLoading(true);
    setError(null);
    setConflict(false);
    try {
      const next = await fetchProjectTeam(
        projectRoot,
        controller ? { signal: controller.signal } : {},
      );
      // 已经有更新的请求了，这次结果直接丢弃。
      if (seq !== loadSeqRef.current) return;
      setConfig(next);
      setDraftAgents(next.agents);
      setDraftCollaboration(next.collaboration);
      setSelectedAgentId(next.agents[0]?.id ?? null);
    } catch (caught) {
      if (seq !== loadSeqRef.current) return;
      if (controller?.signal.aborted) return;
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      if (seq === loadSeqRef.current) setLoading(false);
    }
  }, [projectRoot]);

  // 组件卸载时中断未完成的请求。
  useEffect(
    () => () => {
      loadAbortRef.current?.abort();
    },
    [],
  );

  // 只在项目切换时重新拉取，切换标签页不会触发请求。
  useEffect(() => {
    void load();
  }, [load]);

  const updateAgent = useCallback(
    (agentId: string, patch: Partial<ProjectTeamAgent>) => {
      setDraftAgents((current) =>
        current.map((agent) =>
          agent.id === agentId ? { ...agent, ...patch } : agent,
        ),
      );
    },
    [],
  );

  const addAgent = useCallback(() => {
    if (draftAgents.length >= PROJECT_TEAM_MAX_AGENTS) {
      setError(describeAgentLimitReached(locale));
      return;
    }
    const usedIds = new Set(draftAgents.map((agent) => agent.id));
    let counter = draftAgents.length + 1;
    let id = `agent-${counter}`;
    while (usedIds.has(id)) {
      counter += 1;
      id = `agent-${counter}`;
    }
    // 默认文案跟随界面语言，英文界面不应该出现中文默认值。
    const template = getDefaultAgentTemplate("executor", locale);
    const agent = createProjectTeamAgent("executor", {
      id,
      name: t("members.defaultName", { index: counter }),
      description: template.description,
      roleDefinition: template.roleDefinition,
    });
    setDraftAgents((current) => [...current, agent]);
    setSelectedAgentId(agent.id);
    setActiveTab("roles");
  }, [draftAgents, locale, t]);

  const removeAgent = useCallback((agentId: string) => {
    setDraftAgents((current) =>
      current
        .filter((agent) => agent.id !== agentId)
        // 被删掉的 Agent 不能继续被上级引用：后端会校验 reportsTo 必须指向
        // 同队中存在的 agent id，否则整个保存请求返回 400。
        .map((agent) =>
          agent.reportsTo === agentId ? { ...agent, reportsTo: null } : agent,
        ),
    );
    setSelectedAgentId((current) => (current === agentId ? null : current));
    setPendingRemovalId(null);
  }, []);

  const dirty = useMemo(
    () => isProjectTeamDraftDirty(draftAgents, draftCollaboration, config),
    [config, draftAgents, draftCollaboration],
  );

  const requestReload = useCallback(() => {
    // 有未保存的修改时先确认，避免误点把改动丢掉。
    if (dirty) {
      setPendingReload(true);
      return;
    }
    void load();
  }, [dirty, load]);

  const save = useCallback(async () => {
    if (!projectRoot || !config) return;
    const hasInvalidTool = draftAgents.some((agent) =>
      [
        ...agent.permissions.allowedTools,
        ...agent.permissions.deniedTools,
      ].some((entry) => !isValidToolEntry(entry)),
    );
    if (hasInvalidTool) {
      setError(t("invalidTools"));
      return;
    }
    // 后端一定会拒绝的草稿（名称长度、自定义模型正则、工具条目上限…）
    // 在这里就拦下来，不要白发一次 PUT。
    const validation = validateProjectTeamDraft(draftAgents);
    if (!validation.ok) {
      setError(describeDraftIssue(validation.issue, locale));
      return;
    }
    const targetRoot = projectRoot;
    const seq = ++saveSeqRef.current;
    setSaving(true);
    setError(null);
    setConflict(false);
    try {
      const saved = await saveProjectTeam({
        projectRoot: targetRoot,
        revision: config.revision,
        agents: draftAgents,
        collaboration: draftCollaboration,
      });
      // 保存期间可能切换了项目；这时旧项目的响应不能写进当前状态。
      if (projectRootRef.current !== targetRoot) return;
      if (seq !== saveSeqRef.current) return;
      setConfig(saved);
      setDraftAgents(saved.agents);
      setDraftCollaboration(saved.collaboration);
      showSettingsSuccess(t("actions.saved"));
    } catch (caught) {
      if (seq !== saveSeqRef.current) return;
      if (projectRootRef.current !== targetRoot) return;
      if (caught instanceof ProjectTeamConflictError) {
        setConflict(true);
      } else {
        setError(caught instanceof Error ? caught.message : String(caught));
      }
    } finally {
      if (seq === saveSeqRef.current) setSaving(false);
    }
  }, [config, draftAgents, draftCollaboration, locale, projectRoot, t]);

  const pendingRemoval = draftAgents.find(
    (agent) => agent.id === pendingRemovalId,
  );

  if (projectOptions.length === 0) {
    return (
      <div className="flex flex-col gap-4">
        <PageSectionHeader title={title} description={t("subtitle")} />
        <div className="rounded-xl border border-dashed border-border bg-muted/20 px-4 py-10 text-center text-[13px] text-muted-foreground">
          {t("noProjects")}
        </div>
      </div>
    );
  }

  return (
    <FieldSaveModeProvider mode="immediate">
      <div className="flex flex-col gap-4">
        <PageSectionHeader title={title} description={t("subtitle")} />

        <ProjectToolbar
          projectOptions={projectOptions}
          projectRoot={projectRoot}
          onChangeProject={setProjectRoot}
          onReload={requestReload}
          onSave={() => void save()}
          loading={loading}
          saving={saving}
          canSave={Boolean(config)}
        />

        {conflict ? (
          <div
            role="alert"
            className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-[13px] text-destructive"
          >
            <span>{t("conflict")}</span>
            <button
              type="button"
              onClick={requestReload}
              className="rounded-md border border-destructive/40 px-2 py-1 text-[12px] transition-colors enabled:hover:bg-destructive/10"
            >
              {t("actions.reload")}
            </button>
          </div>
        ) : null}

        {error ? (
          <div
            role="alert"
            className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-[13px] text-destructive"
          >
            {error}
          </div>
        ) : null}

        <TeamTabs activeTab={activeTab} onChangeTab={setActiveTab} />

        {loading ? (
          <div className="flex items-center gap-2 px-1 py-6 text-[13px] text-muted-foreground">
            <Loader2 size={15} className="animate-spin" />
            {t("loading")}
          </div>
        ) : (
          <>
            {activeTab === "members" ? (
              <MembersPanel
                agents={draftAgents}
                selectedAgentId={selectedAgentId}
                onSelectAgent={setSelectedAgentId}
                onChangeAgent={updateAgent}
                onAddAgent={addAgent}
                onEditAgent={(agentId) => {
                  setSelectedAgentId(agentId);
                  setActiveTab("roles");
                }}
                onRequestRemove={setPendingRemovalId}
              />
            ) : null}

            {activeTab === "roles" ? (
              <RolePanel
                agents={draftAgents}
                selectedAgentId={selectedAgentId}
                onSelectAgent={setSelectedAgentId}
                onChangeAgent={updateAgent}
              />
            ) : null}

            {activeTab === "model" ? (
              <ModelPanel
                agents={draftAgents}
                selectedAgentId={selectedAgentId}
                onSelectAgent={setSelectedAgentId}
                onChangeAgent={updateAgent}
              />
            ) : null}

            {activeTab === "tools" ? (
              <ToolsPanel
                agents={draftAgents}
                selectedAgentId={selectedAgentId}
                onSelectAgent={setSelectedAgentId}
                onChangeAgent={updateAgent}
              />
            ) : null}

            {activeTab === "collaboration" ? (
              <CollaborationPanel
                agents={draftAgents}
                collaboration={draftCollaboration}
                onChangeCollaboration={(patch) =>
                  setDraftCollaboration((current) => ({ ...current, ...patch }))
                }
                onChangeAgent={updateAgent}
              />
            ) : null}
          </>
        )}
      </div>

      {pendingRemoval ? (
        <ConfirmDialog
          destructive
          title={t("actions.removeAgentTitle")}
          confirmLabel={t("actions.removeAgent", { name: pendingRemoval.name })}
          onCancel={() => setPendingRemovalId(null)}
          onConfirm={() => removeAgent(pendingRemoval.id)}
        >
          {t("actions.removeAgentConfirm", { name: pendingRemoval.name })}
        </ConfirmDialog>
      ) : null}

      {pendingReload ? (
        <ConfirmDialog
          destructive
          title={t("actions.reload")}
          confirmLabel={t("actions.reload")}
          onCancel={() => setPendingReload(false)}
          onConfirm={() => {
            setPendingReload(false);
            void load();
          }}
        >
          {describeUnsavedChanges(locale)}
        </ConfirmDialog>
      ) : null}
    </FieldSaveModeProvider>
  );
}

export default ProjectTeamSection;
