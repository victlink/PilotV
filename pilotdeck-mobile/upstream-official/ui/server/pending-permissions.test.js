// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import {
    PENDING_PERMISSIONS_TTL_MS,
    recordPendingPermission,
    clearPendingPermission,
    clearPendingPermissionsForSession,
    listPendingPermissions,
    trackPermissionFrames,
    handlePendingPermissionsMessage,
} from './pending-permissions.js';

const request = { kind: 'permission_request', requestId: 'approval-1', toolName: 'Bash', input: { command: 'pwd' }, context: { provider: 'pilotdeck' } };

beforeEach(() => {
    for (const entry of listPendingPermissions()) clearPendingPermission(entry.requestId);
    vi.useFakeTimers();
    vi.setSystemTime(1000000);
});
afterEach(() => {
    for (const entry of listPendingPermissions()) clearPendingPermission(entry.requestId);
    vi.useRealTimers();
});

describe('pending permissions registry', () => {
    it('records permission and elicitation frames for their session', () => {
        trackPermissionFrames([request, { ...request, requestId: 'question', toolName: 'AskUserQuestion', isElicitation: true }], 'session-a');
        expect(listPendingPermissions('session-a')).toEqual([
            expect.objectContaining({ requestId: 'approval-1', sessionId: 'session-a', input: request.input, context: request.context, createdAt: 1000000, updatedAt: 1000000, isElicitation: false }),
            expect.objectContaining({ requestId: 'question', isElicitation: true }),
        ]);
        expect(listPendingPermissions('session-b')).toEqual([]);
    });

    it('deduplicates by requestId, preserving creation time and updating metadata', () => {
        recordPendingPermission({ ...request, sessionId: 'session-a' });
        vi.advanceTimersByTime(100);
        recordPendingPermission({ ...request, sessionId: 'session-a', toolName: 'Updated' });
        expect(listPendingPermissions()).toEqual([expect.objectContaining({ toolName: 'Updated', createdAt: 1000000, updatedAt: 1000100 })]);
    });

    it('clears by requestId, including cancellation frames without sessionId', () => {
        trackPermissionFrames([request], 'session-a');
        trackPermissionFrames([{ kind: 'permission_cancelled', requestId: request.requestId }]);
        expect(listPendingPermissions()).toEqual([]);
        trackPermissionFrames([request], 'session-a');
        clearPendingPermission(request.requestId);
        expect(listPendingPermissions()).toEqual([]);
    });

    it.each([
        { kind: 'complete' },
        { kind: 'interrupted' },
        { kind: 'status', text: 'turn_replaced' },
        { kind: 'error', terminal: true },
    ])('clears the whole session at lifecycle boundary %j', (frame) => {
        trackPermissionFrames([request, { ...request, requestId: 'second' }], 'session-a');
        trackPermissionFrames([{ ...request, requestId: 'other' }], 'session-b');
        trackPermissionFrames([frame], 'session-a');
        expect(listPendingPermissions('session-a')).toEqual([]);
        expect(listPendingPermissions()).toHaveLength(1);
        clearPendingPermissionsForSession('session-b');
        expect(listPendingPermissions()).toEqual([]);
    });

    it('never drops a live prompt because a turn-start frame followed it', () => {
        // A prompt already waiting on the user must survive a later `started`
        // frame for the same session: replayed history can arrive in that order,
        // and clearing here would silently hide an approval the user still owes.
        trackPermissionFrames([{ kind: 'status', text: 'started' }, request], 'session-a');
        expect(listPendingPermissions('session-a')).toHaveLength(1);
        trackPermissionFrames([{ kind: 'status', text: 'started' }], 'session-a');
        expect(listPendingPermissions('session-a')).toHaveLength(1);
    });


    it('does not clear for nonterminal errors or intermediate stream endings', () => {
        trackPermissionFrames([request, { kind: 'error', terminal: false }, { kind: 'stream_end' }], 'session-a');
        expect(listPendingPermissions()).toHaveLength(1);
    });

    it('expires at TTL on read without letting duplicates refresh the deadline', () => {
        trackPermissionFrames([request], 'session-a');
        vi.advanceTimersByTime(PENDING_PERMISSIONS_TTL_MS - 1);
        trackPermissionFrames([request], 'session-a');
        expect(listPendingPermissions()).toHaveLength(1);
        vi.advanceTimersByTime(1);
        expect(listPendingPermissions('session-a')).toEqual([]);
        expect(listPendingPermissions()).toEqual([]);
    });

    it('lists all sessions and handles both WebSocket request shapes', () => {
        trackPermissionFrames([request], 'session-a');
        trackPermissionFrames([{ ...request, requestId: 'other' }], 'session-b');
        expect(listPendingPermissions()).toHaveLength(2);
        const writer = { send: vi.fn() };
        expect(handlePendingPermissionsMessage({ type: 'get-pending-permissions', sessionId: 'session-a' }, writer)).toBe(true);
        expect(writer.send).toHaveBeenLastCalledWith({ type: 'pending-permissions-response', sessionId: 'session-a', data: listPendingPermissions('session-a') });
        expect(handlePendingPermissionsMessage({ type: 'get-all-pending-permissions' }, writer)).toBe(true);
        expect(writer.send).toHaveBeenLastCalledWith({ type: 'all-pending-permissions-response', data: listPendingPermissions() });
        handlePendingPermissionsMessage({ type: 'get-pending-permissions' }, writer);
        expect(writer.send).toHaveBeenLastCalledWith({ type: 'pending-permissions-response', sessionId: undefined, data: [] });
        expect(handlePendingPermissionsMessage({ type: 'unrelated' }, writer)).toBe(false);
    });

    it('wires the lightweight handler into index and tracking into the live bridge, not replay', () => {
        const index = readFileSync(new URL('./index.js', import.meta.url), 'utf8');
        const bridge = readFileSync(new URL('./pilotdeck-bridge.js', import.meta.url), 'utf8');
        expect(index).toContain('handlePendingPermissionsMessage(data, writer);');
        expect(bridge).toContain('return trackPermissionFrames(mapGatewayEventToFrames(event, sessionId, provider), sessionId);');
        expect(bridge).toContain('snapshot.events.flatMap((event) => mapGatewayEventToFrames(event, sessionId, provider) || [])');
    });
});
