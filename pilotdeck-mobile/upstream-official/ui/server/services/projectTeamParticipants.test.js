import { expect, it } from 'vitest';
import { recordProjectParticipant } from './projectTeamParticipants.js';
it('records only resolved project identities, independent of native subagents', () => {
 const state = {};
 recordProjectParticipant(state, { agentId: 'team-a', agent: { name:'Ada', role:'reviewer' } });
 recordProjectParticipant(state, { agentId: 'team-a', agent: { name:'Ada New', role:'reviewer' } });
 recordProjectParticipant(state, null);
 expect(state.projectParticipants).toEqual([{agentId:'team-a',name:'Ada New',role:'reviewer'}]);
});
