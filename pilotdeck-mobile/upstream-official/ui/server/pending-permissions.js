/** Process-local pending approvals, shared by the gateway bridge and WebSocket handlers. */
export const PENDING_PERMISSIONS_TTL_MS = 45 * 60 * 1000;
const pendingPermissions = new Map();

/**
 * The risk level belongs to the authoritative backend policy
 * (`src/approval/ApprovalPolicy.ts` -> `classifyApprovalRisk`). The UI server
 * must never classify a tool on its own: a local copy of the ladder drifts
 * from the backend (it knows nothing about tools such as `git`, `python` or
 * `keychain`) and would let the UI display a risk level the backend never
 * approved. Only a risk value that the backend delivered with the frame is
 * carried through; without it the risk stays unknown.
 */
const AUTHORITATIVE_RISKS = new Set(['low', 'medium', 'high', 'critical']);

function authoritativeRisk(value) {
    const risk = typeof value === 'string' ? value.trim().toLowerCase() : '';
    return AUTHORITATIVE_RISKS.has(risk) ? risk : undefined;
}

export function recordPendingPermission({ requestId, sessionId, toolName, input, context, isElicitation, risk }) {
    if (!requestId || !sessionId) return;
    const now = Date.now();
    const previous = pendingPermissions.get(requestId);
    pendingPermissions.set(requestId, {
        requestId, sessionId, toolName, input, context,
        isElicitation: Boolean(isElicitation),
        risk: authoritativeRisk(risk) ?? previous?.risk,
        expiresAt: (previous?.createdAt ?? now) + PENDING_PERMISSIONS_TTL_MS,
        createdAt: previous?.createdAt ?? now,
        updatedAt: now,
    });
}


export function clearPendingPermission(requestId) {
    pendingPermissions.delete(requestId);
}

export function clearPendingPermissionsForSession(sessionId) {
    for (const [requestId, entry] of pendingPermissions) {
        if (entry.sessionId === sessionId) pendingPermissions.delete(requestId);
    }
}

/** Prune on every read, including reads for a single session. Duplicates do not extend TTL. */
export function listPendingPermissions(sessionId) {
    const now = Date.now();
    const result = [];
    for (const [requestId, entry] of pendingPermissions) {
        if (now - entry.createdAt >= PENDING_PERMISSIONS_TTL_MS) {
            pendingPermissions.delete(requestId);
        } else if (sessionId === undefined || entry.sessionId === sessionId) {
            result.push({ ...entry, receivedAt: new Date(entry.createdAt) });
        }
    }
    return result;
}

/** Track normalized live frames; transcript replay must not mutate pending state. */
export function trackPermissionFrames(frames, sessionId) {
    for (const frame of frames) {
        const resolvedSessionId = sessionId || frame.sessionId;
        if (frame.kind === 'permission_request') {
            recordPendingPermission({
                requestId: frame.requestId,
                sessionId: resolvedSessionId,
                toolName: frame.toolName,
                input: frame.input,
                context: frame.context,
                isElicitation: frame.isElicitation,
                risk: frame.risk,
            });
        } else if (frame.kind === 'permission_cancelled') {
            clearPendingPermission(frame.requestId);
        } else if (frame.kind === 'complete' || frame.kind === 'interrupted'
            || (frame.kind === 'error' && frame.terminal === true)
            || (frame.kind === 'status' && frame.text === 'turn_replaced')) {
            clearPendingPermissionsForSession(resolvedSessionId);
        }
    }
    return frames;
}

/** Lightweight handler shared with index.js, without importing the server runtime. */
export function handlePendingPermissionsMessage(message, writer) {
    if (message.type === 'get-pending-permissions') {
        writer.send({
            type: 'pending-permissions-response',
            sessionId: message.sessionId,
            data: message.sessionId ? listPendingPermissions(message.sessionId) : [],
        });
        return true;
    }
    if (message.type === 'get-all-pending-permissions') {
        writer.send({ type: 'all-pending-permissions-response', data: listPendingPermissions() });
        return true;
    }
    return false;
}
