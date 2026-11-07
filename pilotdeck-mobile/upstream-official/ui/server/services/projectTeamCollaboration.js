/** Decide whether a completed project-agent turn should start one reviewer turn. */
export function selectProjectReviewer(config, { agentId, reviewDepth = 0, explicit = false } = {}) {
    if (!config || reviewDepth > 0) return null;
    const agents = Array.isArray(config.agents) ? config.agents : [];
    if (explicit) {
        // An explicit user request also runs in manual mode: "manual" only
        // means "do not review automatically", not "reviewing is impossible".
        // The requested member wins when it is an enabled reviewer, otherwise
        // the first enabled reviewer of the team is used.
        const preferred = agentId
            ? agents.find((agent) => agent.enabled && agent.role === 'reviewer' && agent.id === agentId)
            : null;
        if (preferred) return preferred;
        return agents.find((agent) => agent.enabled && agent.role === 'reviewer') || null;
    }
    const mode = config.collaboration?.mode || 'manual';
    if (mode === 'manual') return null;
    const current = agents.find((agent) => agent.id === agentId);
    if (current?.role === 'reviewer') return null;
    const candidates = agents.filter((agent) => agent.enabled && agent.role === 'reviewer' && agent.id !== agentId);
    // A reviewer may be a team-level reviewer (reportsTo:null) or report to
    // the member whose turn just completed.  Do not let an unrelated reviewer
    // silently review a selected member.
    const constrained = candidates.filter((agent) => agent.reportsTo == null || (current && agent.reportsTo === current.id));
    return constrained[0] || null;
}

export function buildProjectReviewRequest({ agentName, runId }) {
    return `审查项目成员「${agentName}」刚完成的用户轮次（runId: ${runId}）。请独立检查其结果，指出具体问题和改进建议；不要伪造用户消息。`;
}
