import type {
  ProjectTeamAgent,
  ProjectTeamCollaboration,
} from "../../../../lib/projectTeam";

export type TeamTabKey =
  | "members"
  | "roles"
  | "model"
  | "tools"
  | "collaboration";

export const TEAM_TABS: TeamTabKey[] = [
  "members",
  "roles",
  "model",
  "tools",
  "collaboration",
];

export type AgentPanelProps = {
  agents: ProjectTeamAgent[];
  selectedAgentId: string | null;
  onSelectAgent: (agentId: string) => void;
  onChangeAgent: (
    agentId: string,
    patch: Partial<ProjectTeamAgent>,
  ) => void;
};

export type CollaborationPanelProps = {
  agents: ProjectTeamAgent[];
  collaboration: ProjectTeamCollaboration;
  onChangeCollaboration: (
    patch: Partial<ProjectTeamCollaboration>,
  ) => void;
  onChangeAgent: (agentId: string, patch: Partial<ProjectTeamAgent>) => void;
};
