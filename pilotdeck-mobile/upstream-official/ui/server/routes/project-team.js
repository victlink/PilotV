import express from 'express';

import {
    ProjectTeamConfigError,
    readProjectTeamConfig,
    validateProjectTeamPayload,
    writeProjectTeamConfig,
} from '../services/projectTeamConfig.js';

// The gateway snapshot is a nice-to-have: when the gateway is unavailable the
// local `.cwd` markers still allow locally registered projects to be
// configured. Never let a hanging gateway stall the request.
const SNAPSHOT_TIMEOUT_MS = 1000;

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
    const provider = snapshotProvider ?? defaultSnapshotProvider;

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
