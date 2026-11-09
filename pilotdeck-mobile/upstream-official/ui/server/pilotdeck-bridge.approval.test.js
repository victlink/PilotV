// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The bridge reads the persisted queue state of a session; the test must not
// touch the real pilot home.
const mock = await vi.hoisted(async () => {
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const previousHome = process.env.PILOT_HOME;
    process.env.PILOT_HOME = mkdtempSync(join(tmpdir(), 'pilotdeck-bridge-approval-'));
    const calls = { permissionDecide: [], respondElicitation: [] };
    const gateway = {
        async permissionDecide(input) {
            calls.permissionDecide.push(input);
            // A request id prefixed with `unhandled-` is never acknowledged, so
            // the legacy "ask every session" path can be observed.
            return { delivered: !String(input.requestId).startsWith('unhandled-') };
        },
        async respondElicitation(input) {
            calls.respondElicitation.push(input);
            return { delivered: !String(input.requestId).startsWith('unhandled-') };
        },
    };
    return { calls, gateway, previousHome };
});

vi.mock('./services/gatewayConnectionCache.js', () => ({
    createGatewayConnectionCache: () => ({ get: async () => mock.gateway, current: () => mock.gateway, invalidate: () => {} }),
}));

// The real gateway client and the global proxy pull in every model provider;
// this test only exercises how the bridge routes a decision to a session.
vi.mock('../../src/gateway/index.js', () => ({ createRemoteGateway: () => ({}) }));
vi.mock('../../src/cli/proxy.js', () => ({ installGlobalProxy: async () => {} }));
// The model free history reads the session transcripts, which import the model
// runtime with every provider SDK.
vi.mock('./services/modelFreeHistory.js', () => ({ createModelFreeHistory: () => ({}) }));

const { decidePermissionViaGateway, elicitationRespondViaGateway, getAcceptedModelSelection } = await import('./pilotdeck-bridge.js');

const PROJECT = '/tmp/pilotdeck-approval-bridge-project';

beforeEach(() => {
    mock.calls.permissionDecide.length = 0;
    mock.calls.respondElicitation.length = 0;
});

describe('permission bridge session scoping', () => {
    it('delivers a decision only into the session that owns the request', async () => {
        getAcceptedModelSelection(PROJECT, 'web:session-one');
        getAcceptedModelSelection(PROJECT, 'web:session-two');
        const delivered = await decidePermissionViaGateway('req-1', 'allow', { sessionId: 'web:session-two', actor: 'alice' });
        expect(delivered).toBe(true);
        expect(mock.calls.permissionDecide).toHaveLength(1);
        expect(mock.calls.permissionDecide[0]).toMatchObject({
            sessionKey: 'web:session-two',
            requestId: 'req-1',
            decision: 'allow',
            actor: 'alice',
            actorSource: 'client_reported',
            origin: 'web',
        });
    });

    it('fails instead of falling back to every session when the session is unknown', async () => {
        getAcceptedModelSelection(PROJECT, 'web:session-one');
        const delivered = await decidePermissionViaGateway('req-2', 'deny', { sessionId: 'web:missing-session' });
        expect(delivered).toBe(false);
        expect(mock.calls.permissionDecide).toHaveLength(0);
    });

    it('keeps the legacy behaviour when no session id is given', async () => {
        getAcceptedModelSelection(PROJECT, 'web:legacy-one');
        getAcceptedModelSelection(PROJECT, 'web:legacy-two');
        const delivered = await decidePermissionViaGateway('unhandled-legacy', 'deny', {});
        expect(delivered).toBe(false);
        expect(mock.calls.permissionDecide.length).toBeGreaterThanOrEqual(2);
        expect(mock.calls.permissionDecide.map(call => call.sessionKey)).toEqual(expect.arrayContaining(['web:legacy-one', 'web:legacy-two']));
    });

    it('reports the web actor as client_reported and never as a channel identity', async () => {
        await decidePermissionViaGateway('req-3', 'deny', { sessionId: 'web:session-one', actor: 'alice', actorSource: 'channel_identity' });
        expect(mock.calls.permissionDecide[0].actorSource).toBe('client_reported');
        expect(mock.calls.permissionDecide[0].actor).toBe('alice');
    });

    it('omits the actor instead of inventing one', async () => {
        await decidePermissionViaGateway('req-4', 'deny', { sessionId: 'web:session-one' });
        expect(mock.calls.permissionDecide[0]).not.toHaveProperty('actor');
        expect(mock.calls.permissionDecide[0].actorSource).toBe('client_reported');
    });

    it('answers an elicitation in the requested session only', async () => {
        getAcceptedModelSelection(PROJECT, 'web:session-two');
        const delivered = await elicitationRespondViaGateway('el-1', { type: 'answered', answers: { Q: 'A' } }, 'web:session-two', 'alice');
        expect(delivered).toBe(true);
        expect(mock.calls.respondElicitation).toHaveLength(1);
        expect(mock.calls.respondElicitation[0]).toMatchObject({
            sessionKey: 'web:session-two',
            requestId: 'el-1',
            actor: 'alice',
            actorSource: 'client_reported',
        });
    });

    it('fails an elicitation for an unknown session without touching other sessions', async () => {
        getAcceptedModelSelection(PROJECT, 'web:session-one');
        const delivered = await elicitationRespondViaGateway('el-2', { type: 'answered', answers: {} }, 'web:missing-session', 'alice');
        expect(delivered).toBe(false);
        expect(mock.calls.respondElicitation).toHaveLength(0);
    });
});
