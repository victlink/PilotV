/** Decide whether a completed project-agent turn should start one reviewer turn. */
export function selectProjectReviewer(config, { agentId, reviewDepth = 0 } = {}) {
    if (!config || reviewDepth > 0) return null;
    const mode = config.collaboration?.mode || 'manual';
    if (mode === 'manual') return null;
    const current = config.agents?.find((agent) => agent.id === agentId);
    if (current?.role === 'reviewer') return null;
    const candidates = config.agents.filter((agent) => agent.enabled && agent.role === 'reviewer' && agent.id !== agentId);
    // A reviewer may be a team-level reviewer (reportsTo:null) or report to
    // the member whose turn just completed.  Do not let an unrelated reviewer
    // silently review a selected member.
    const constrained = candidates.filter((agent) => agent.reportsTo == null || (current && agent.reportsTo === current.id));
    return constrained[0] || null;
}

export function buildProjectReviewRequest({ agentName, runId }) {
    return `审查项目成员「${agentName}」刚完成的用户轮次（runId: ${runId}）。请独立检查其结果，指出具体问题和改进建议；不要伪造用户消息。`;
}
