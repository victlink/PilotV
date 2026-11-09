export type SettingsMenuKey =
  | 'general'
  | 'appearance'
  | 'modelPool'
  | 'usage'
  | 'agent'
  | 'agentRoute'
  | 'agentMemory'
  | 'agentResident'
  | 'agentSearch'
  | 'multimodalGeneration'
  | 'agentSchedule'
  | 'projectTeam'
  | 'integrations'
  | 'extensions'
  | 'mcpServers'
  | 'officePreview'
  | 'computerUse'
  | 'privacy'
  | 'approvalChannel'
  | 'advanced'
  | 'about';

export type SettingsMenuItem = {
  key: SettingsMenuKey;
  label: string;
  children?: SettingsMenuItem[];
  showDot?: boolean;
};
