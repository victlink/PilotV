from pathlib import Path
base=Path('pilotdeck-mobile/upstream-official/ui')
p=base/'server/pilotdeck-bridge.js';s=p.read_text();s="import { recordProjectParticipant } from './services/projectTeamParticipants.js';\n"+s
s=s.replace('state.lastAcceptedModelSelection = parsed.lastAcceptedModelSelection;', 'state.lastAcceptedModelSelection = parsed.lastAcceptedModelSelection;\n        state.projectParticipants = Array.isArray(parsed.projectParticipants) ? parsed.projectParticipants : [];')
s=s.replace('!state.lastAcceptedModelSelection && !state.acceptedInputIds?.size', '!state.lastAcceptedModelSelection && !state.projectParticipants?.length && !state.acceptedInputIds?.size')
s=s.replace('lastAcceptedModelSelection: state.lastAcceptedModelSelection,','lastAcceptedModelSelection: state.lastAcceptedModelSelection,\n            projectParticipants: state.projectParticipants,')
s=s.replace("inputAccepted = true;\n                writer.send", "inputAccepted = true;\n                recordProjectParticipant(state, projectRuntime);\n                persistQueueState(state, true);\n                writer.send({ type: 'project-participants', sessionId: sessionKey, projectRoot: projectKey, participants: state.projectParticipants ?? [] });\n                writer.send")
s += "\nexport function getProjectParticipants(sessionId) {\n    return sessionState.get(sessionId)?.projectParticipants ?? [];\n}\n"
p.write_text(s)
p=base/'server/index.js';s=p.read_text();s="import { getProjectParticipants } from './pilotdeck-bridge.js';\n"+s;s=s.replace("type: 'session-status',\n                    sessionId,", "type: 'session-status',\n                    sessionId,\n                    projectParticipants: getProjectParticipants(sessionId),")
p.write_text(s)
p=base/'src/components/chat-v2/ChatInterfaceV2.tsx';s=p.read_text();needle='  const teamStrip = <ProjectTeamStrip';idx=s.index(needle)
s=s[:idx]+s[idx:].replace('onSelect={setSelectedAgentId} />;', 'onSelect={setSelectedAgentId} participants={participantsState.sessionId === (selectedSession?.id || currentSessionId) ? participantsState.participants : []} />;',1)
needle="  const setViewReady = useContext(SessionViewReadyContext);"
s=s.replace(needle,"  const [participantsState, setParticipantsState] = useState<{sessionId: string; participants: Array<{agentId: string; name: string; role: string}>}>({sessionId: '', participants: []});\n"+needle)
needle='  const teamStrip = <ProjectTeamStrip'
s=s.replace(needle,"  useEffect(() => contextSubscribe((message: any) => {\n    if ((message?.type === 'project-participants' || message?.type === 'session-status') && message.sessionId === (selectedSession?.id || currentSessionId)) {\n      const participants = message.type === 'project-participants' ? message.participants : message.projectParticipants;\n      if (Array.isArray(participants)) setParticipantsState({sessionId: message.sessionId, participants});\n    }\n  }), [contextSubscribe, selectedSession?.id, currentSessionId]);\n\n"+needle)
p.write_text(s)
p=base/'src/components/chat-v2/ProjectTeamStrip.tsx';s=p.read_text().replace('onSelect }: {','onSelect, participants = [] }: {').replace('  agents: ProjectTeamAgent[];','  agents: ProjectTeamAgent[];\n  participants?: Array<{agentId: string; name: string; role: string}>;')
s=s.replace('if (!agents.length) return null;', 'if (!agents.length && !participants.length) return null;')
s=s.replace('<span className="shrink-0 px-2 text-xs text-neutral-500">', '<span className="shrink-0 px-2 text-xs text-neutral-500">')
s=s.replace("{[{ id: null,", "{participants.length > 0 && <span className=\"shrink-0 px-2 text-xs text-emerald-700 dark:text-emerald-400\" data-testid=\"task-participants\">{zh ? '已参与：' : 'Participated: '}{participants.map((p) => p.name).join(' · ')}</span>}\n        {[{ id: null,")
p.write_text(s)
print('Wired server-confirmed participants, persistence, reconnect status and top strip')
