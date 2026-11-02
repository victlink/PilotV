/** Separate identity domain from gateway/native subagentId. */
export function recordProjectParticipant(state, runtime) {
    if (!runtime?.agentId || !runtime.agent) return;
    const participants = state.projectParticipants ?? [];
    state.projectParticipants = [
        ...participants.filter((item) => item.agentId !== runtime.agentId),
        { agentId: runtime.agentId, name: runtime.agent.name, role: runtime.agent.role },
    ];
}
