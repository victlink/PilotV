export type SettingsMenuKey =
  | 'general'
  | 'appearance'
  | 'modelPool'
  | 'agent'
  | 'agentRoute'
  | 'agentMemory'
  | 'agentResident'
  | 'agentSearch'
  | 'agentSchedule'
  | 'projectTeam'
  | 'integrations'
  | 'extensions'
  | 'mcpServers'
  | 'officePreview'
  | 'computerUse'
  | 'privacy'
  | 'advanced'
  | 'about';

export type SettingsMenuItem = {
  key: SettingsMenuKey;
  label: string;
  children?: SettingsMenuItem[];
  showDot?: boolean;
};
