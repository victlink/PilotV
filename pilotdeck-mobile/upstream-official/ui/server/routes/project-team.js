import express from 'express';
import { getSessionAgentBinding, setSessionAgentBinding } from '../services/projectTeamRuntime.js';

import {
    ProjectTeamConfigError,
    readProjectTeamConfig,
    validateProjectTeamPayload,
    writeProjectTeamConfig,
} from '../services/projectTeamConfig.js';

// The gateway snapshot is a nice-to-have: when the gateway is unavailable the
// local `.cwd` markers still allow locally registered projects to be
// configured. Never let a hanging gateway stall the request.
//
// The bound has to clear the real gateway latency: `getProjectsSnapshot()`
// walks every project to count its sessions and takes ~1.3-1.6s in
// production. A 1s timeout truncated the snapshot, so every project root that
// only the gateway knows about (no local `.cwd` marker) was reported as
// "not a registered project root" and the settings panel showed a 404.
export const SNAPSHOT_TIMEOUT_MS = 8000;

// The snapshot is cached so opening the settings panel does not wait for the
// gateway on every request. Roots registered locally never reach this path.
const SNAPSHOT_CACHE_TTL_MS = 30000;

function withTimeout(promise, timeoutMs) {
    let timer = null;
    const timeout = new Promise((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs);
        timer.unref?.();
    });
    return Promise.race([Promise.resolve(promise), timeout]).finally(() => {
        if (timer) clearTimeout(timer);
    });
}

/**
 * Default registration source: the gateway project snapshot. The import is
 * dynamic so this router stays usable (and testable) without loading the
 * gateway bridge.
 */
async function defaultSnapshotProvider() {
    try {
        const { getProjectsSnapshot } = await import('../projects.js');
        const snapshot = await withTimeout(getProjectsSnapshot(), SNAPSHOT_TIMEOUT_MS);
        return snapshot?.projects ?? [];
    } catch {
        return [];
    }
}

/**
 * Wrap a snapshot provider with a short-lived cache.
 *
 * - concurrent requests share one in-flight snapshot;
 * - a successful snapshot is reused for `SNAPSHOT_CACHE_TTL_MS`;
 * - when the gateway fails we keep serving the last known snapshot instead
 *   of dropping every gateway-registered project root.
 */
function createSnapshotCache(loadSnapshot) {
    let cached = null;
    let cachedAt = 0;
    let inflight = null;

    return async function snapshotProvider() {
        const now = Date.now();
        if (cached && now - cachedAt < SNAPSHOT_CACHE_TTL_MS) {
            return cached;
        }
        if (!inflight) {
            inflight = (async () => {
                try {
                    const projects = await loadSnapshot();
                    const list = Array.isArray(projects) ? projects : [];
                    cached = list;
                    cachedAt = Date.now();
                    return list;
                } catch {
                    return cached ?? [];
                } finally {
                    inflight = null;
                }
            })();
        }
        return inflight;
    };
}

function readProjectRootParam(req) {
    const value = req.query?.projectRoot;
    if (typeof value !== 'string' || value.trim() === '') {
        throw new ProjectTeamConfigError('projectRoot query parameter is required.', {
            statusCode: 400,
            code: 'PROJECT_ROOT_REQUIRED',
        });
    }
    return value;
}

function sendError(res, error) {
    if (error instanceof ProjectTeamConfigError) {
        res.status(error.statusCode).json({ error: error.message });
        return;
    }
    console.error('[project-team] request failed:', error);
    res.status(500).json({ error: 'Failed to handle the project team configuration request.' });
}

/**
 * Router for the per-project agent team configuration.
 *
 *   GET /api/project-team?projectRoot=<absolute project root>
 *     → { version: 1, revision: "<opaque>", agents: [...] }
 *
 *   PUT /api/project-team?projectRoot=<absolute project root>
 *     body: { version: 1, revision: "<opaque>", agents: [...] }
 *     → { version: 1, revision: "<new opaque>", agents: [...] }
 *
 * Phase 1 only stores the configuration. Nothing here starts an agent, grants
 * a permission or schedules work.
 */
export function createProjectTeamRouter({ snapshotProvider = null } = {}) {
    const router = express.Router();
    const provider = createSnapshotCache(snapshotProvider ?? defaultSnapshotProvider);

    router.get('/session-agent', async (req, res) => {
        try {
            res.json(await getSessionAgentBinding({ projectRoot: readProjectRootParam(req), sessionKey: req.query.sessionKey, snapshotProvider: provider }));
        } catch (error) { sendError(res, error); }
    });
    router.put('/session-agent', async (req, res) => {
        try {
            res.json(await setSessionAgentBinding({ projectRoot: readProjectRootParam(req), sessionKey: req.query.sessionKey, agentId: req.body?.agentId, snapshotProvider: provider }));
        } catch (error) { sendError(res, error); }
    });

    router.get('/', async (req, res) => {
        try {
            const projectRoot = readProjectRootParam(req);
            const config = await readProjectTeamConfig({
                projectRoot,
                snapshotProvider: provider,
            });
            res.json(config);
        } catch (error) {
            sendError(res, error);
        }
    });

    router.put('/', async (req, res) => {
        try {
            const projectRoot = readProjectRootParam(req);
            const payload = req.body ?? {};
            const validation = validateProjectTeamPayload(payload);
            if (!validation.valid) {
                res.status(400).json({ error: validation.errors.join(' ') });
                return;
            }

            const config = await writeProjectTeamConfig({
                projectRoot,
                revision: payload.revision,
                agents: payload.agents,
                collaboration: payload.collaboration,
                snapshotProvider: provider,
            });
            res.json(config);
        } catch (error) {
            sendError(res, error);
        }
    });

    return router;
}

export default createProjectTeamRouter();
