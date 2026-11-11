import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { resolvePilotHome } from '../utils/pilotPaths.js';
import { ProjectTeamConfigError } from './projectTeamConfig.js';

// The local gateway uses the same on-disk key to enforce saved solo mode on
// direct gateway submissions too. Never use a client-supplied mode to relax it.
function modePath(projectRoot, sessionKey) {
    if (typeof sessionKey !== 'string' || !sessionKey.trim() || sessionKey.length > 512) {
        throw new ProjectTeamConfigError('A session key is required.', { statusCode: 400, code: 'SESSION_KEY_REQUIRED' });
    }
    let root = path.resolve(projectRoot);
    try { root = realpathSync(root); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const key = createHash('sha256').update(JSON.stringify([root, sessionKey])).digest('hex');
    return path.join(resolvePilotHome(), 'session-execution-modes', `${key}.json`);
}

function isExecutionMode(value) {
    return value === 'autoSplit' || value === 'solo';
}

export function readSessionExecutionMode(projectRoot, sessionKey) {
    try {
        const { executionMode } = JSON.parse(readFileSync(modePath(projectRoot, sessionKey), 'utf8'));
        if (!isExecutionMode(executionMode)) throw new Error('Invalid stored execution mode.');
        return executionMode;
    } catch (error) {
        if (error.code === 'ENOENT') return 'autoSplit';
        throw error;
    }
}

export function writeSessionExecutionMode(projectRoot, sessionKey, executionMode) {
    if (!isExecutionMode(executionMode)) {
        throw new ProjectTeamConfigError('executionMode must be autoSplit or solo.', { statusCode: 400, code: 'EXECUTION_MODE_INVALID' });
    }
    const file = modePath(projectRoot, sessionKey);
    mkdirSync(path.dirname(file), { recursive: true });
    const temp = `${file}.${randomUUID()}.tmp`;
    try {
        writeFileSync(temp, JSON.stringify({ executionMode }), { mode: 0o600 });
        renameSync(temp, file);
    } finally {
        rmSync(temp, { force: true });
    }
    return executionMode;
}
