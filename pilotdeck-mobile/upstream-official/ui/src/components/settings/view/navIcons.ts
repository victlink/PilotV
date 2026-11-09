import multimodalGenerationIcon from "../assets/nav/multimodal-generation.svg?raw";
import type { SettingsMenuKey } from "../types";
import aboutIcon from "../assets/nav/about.svg?raw";
import advancedIcon from "../assets/nav/advanced.svg?raw";
import agentMemoryIcon from "../assets/nav/agent-memory.svg?raw";
import agentResidentIcon from "../assets/nav/agent-resident.svg?raw";
import agentRouteIcon from "../assets/nav/agent-route.svg?raw";
import agentScheduleIcon from "../assets/nav/agent-schedule.svg?raw";
import agentSearchIcon from "../assets/nav/agent-search.svg?raw";
import backIcon from "../assets/nav/back.svg?raw";
import configIcon from "../assets/nav/config.svg?raw";
import computerControlIcon from "../assets/nav/computer-control.svg?raw";
import generalIcon from "../assets/nav/general.svg?raw";
import integrationsIcon from "../assets/nav/integrations.svg?raw";
import mcpIcon from "../assets/nav/mcp.svg?raw";
import modelPoolIcon from "../assets/nav/model-pool.svg?raw";
import officeIcon from "../assets/nav/office.svg?raw";
import privacyIcon from "../assets/nav/privacy.svg?raw";
import projectTeamIcon from "../assets/nav/project-team.svg?raw";

export const SETTINGS_BACK_ICON = backIcon;
export const SETTINGS_CONFIG_ICON = configIcon;

export const SETTINGS_NAV_ICONS: Partial<Record<SettingsMenuKey, string>> = {
  general: generalIcon,
  appearance: '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="12" cy="12" r="9"/><path d="M12 3v18"/><path d="M12 3a9 9 0 0 1 0 18" fill="currentColor"/></svg>',
  modelPool: modelPoolIcon,
  usage: '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 3v17h17M8 16v-5m5 5V7m5 9V4"/></svg>',
  agentRoute: agentRouteIcon,
  agentMemory: agentMemoryIcon,
  agentResident: agentResidentIcon,
  agentSearch: agentSearchIcon,
  multimodalGeneration: multimodalGenerationIcon,
  agentSchedule: agentScheduleIcon,
  projectTeam: projectTeamIcon,
  integrations: integrationsIcon,
  mcpServers: mcpIcon,
  officePreview: officeIcon,
  computerUse: computerControlIcon,
  privacy: privacyIcon,
  // 审批通道和其它设置项一样要有导航图标，否则这一行会明显比其它项空。
  approvalChannel: '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="m9 12 2 2 4-4"/></svg>',
  advanced: advancedIcon,
  about: aboutIcon,
};
