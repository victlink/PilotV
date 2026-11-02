from pathlib import Path
root=Path('pilotdeck-mobile/upstream-official/ui/src')
p=root/'components/chat-v2/ComposerV2.tsx'
s=p.read_text(); start=s.index('                  {agents.length > 0 ? ('); end=s.index('                <div className="pd-composer-model-control',start)
s=s[:start]+s[end:]; p.write_text(s)
p=root/'components/chat-v2/ChatInterfaceV2.tsx';s=p.read_text();s="import ProjectTeamStrip from './ProjectTeamStrip';\n"+s
s=s.replace('  if (isWelcomeMode) {','  const teamStrip = <ProjectTeamStrip agents={teamAgents} selectedAgentId={activeAgentId} onSelect={setSelectedAgentId} />;\n\n  if (isWelcomeMode) {')
s=s.replace('<div className="pd-chat-canvas flex min-h-0 min-w-0 flex-1 flex-col bg-white dark:bg-neutral-950">','<div className="pd-chat-canvas flex min-h-0 min-w-0 flex-1 flex-col bg-white dark:bg-neutral-950">\n          {teamStrip}')
s=s.replace('<div className="pd-chat-canvas flex h-full flex-col bg-white dark:bg-neutral-950">','<div className="pd-chat-canvas flex h-full flex-col bg-white dark:bg-neutral-950">\n        {teamStrip}')
s=s.replace('grid-rows-[minmax(0,1fr)_auto]','grid-rows-[auto_minmax(0,1fr)_auto]')
s=s.replace('      <ErrorBoundary showDetails resetKeys={[selectedSession?.id, selectedProject?.name]}>','      {teamStrip}\n      <ErrorBoundary showDetails resetKeys={[selectedSession?.id, selectedProject?.name]}>')
p.write_text(s)
p=root/'components/app-shell/AppShellV2.tsx';s=p.read_text().replace('/settings/projectTeam?projectRoot=','/settings/project-team?projectRoot=');p.write_text(s)
p=root/'components/settings/view/projectTeam/index.tsx';s=p.read_text();s=s.replace('  // 项目列表是异步到达的，选中第一个可用项目。','  const appliedRequestedRoot = useRef<string | null>(null);\n  // Apply a deep link once; later manual project changes remain possible.')
s=s.replace('if (requestedProjectRoot && projectOptions.some((option) => option.value === requestedProjectRoot)) {','if (requestedProjectRoot && appliedRequestedRoot.current !== requestedProjectRoot && projectOptions.some((option) => option.value === requestedProjectRoot)) {\n      appliedRequestedRoot.current = requestedProjectRoot;')
p.write_text(s)
p=root/'components/chat-v2/ComposerV2.agent.test.tsx';s=p.read_text();s=s[:s.index("describe('ComposerV2")]+"\n" if "describe('ComposerV2" in s else s;p.write_text(s)
print('Updated composer, team strip integration, settings route and project deep link')
