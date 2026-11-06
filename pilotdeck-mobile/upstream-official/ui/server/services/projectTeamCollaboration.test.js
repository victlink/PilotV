import { describe, expect, it } from 'vitest';
import { buildProjectReviewRequest, selectProjectReviewer } from './projectTeamCollaboration.js';

describe('project collaboration reviewer selection', () => {
    const config = { collaboration: { mode: 'automated' }, agents: [
        { id: 'worker', name: 'Worker', role: 'executor', reportsTo: null, enabled: true },
        { id: 'reviewer', name: 'Reviewer', role: 'reviewer', reportsTo: 'worker', enabled: true },
    ] };
    it('selects an enabled reviewer reporting to the completed agent', () => {
        expect(selectProjectReviewer(config, { agentId: 'worker' }).id).toBe('reviewer');
    });
    it('does not recurse or run in manual mode', () => {
        expect(selectProjectReviewer(config, { agentId: 'worker', reviewDepth: 1 })).toBeNull();
        expect(selectProjectReviewer({ ...config, collaboration: { mode: 'manual' } }, { agentId: 'worker' })).toBeNull();
    });
    it('builds a non-user review request', () => {
        expect(buildProjectReviewRequest({ agentName: 'Worker', runId: 'r1' })).toContain('r1');
    });
});
