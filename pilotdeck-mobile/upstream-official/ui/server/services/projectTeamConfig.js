/**
 * Project team configuration — phase 1 (configuration storage only).
 *
 * A "project team" is the set of agents a project may run: a commander, one or
 * more executors, reviewers and supervisors. This module owns the *storage
 * layer* for that definition:
 *
 *   - Storage location: `<projectRoot>/.pilotdeck/project-team.json`
 *   - Shape: `{ version: 1, revision: "<opaque>", agents: [...] }`
 *   - Optimistic concurrency: every successful write issues a new opaque
 *     revision; a write whose revision does not match the stored one is
 *     rejected with a conflict instead of overwriting someone else's work.
 *
 * Deliberately out of scope for this phase (do not add here):
 *   - Running agents, scheduling or dispatching anything.
 *   - Enforcing the stored tool authorization: the permissions of an agent are
 *     stored and validated here, but granting them at runtime is the job of
 *     the gateway, not of this storage layer.
 *   - Any credential storage: the payload schema rejects unknown fields, so
 *     API keys cannot be persisted through this API.
 *
 * Safety rules enforced here:
 *   - Only the exact root directory of a registered project may be written to.
 *     A project is "registered" when its root is either listed by the local
 *     `~/.pilotdeck/projects/<id>/.cwd` marker or reported by the gateway
 *     project snapshot. Nested paths and arbitrary directories are rejected.
 *   - The `.pilotdeck` directory and the `project-team.json` file must not be
 *     symlinks; writes are never redirected outside the project root.
 *   - Writes are atomic (temp file + rename) and never leave partial files.
 *   - A corrupted configuration file is never silently overwritten.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import { resolvePilotHome, ensurePilotProjectGitIgnore } from '../utils/pilotPaths.js';
import { isPathInsideOrEqual } from '../utils/pathSafety.js';

export const PROJECT_TEAM_CONFIG_VERSION = 1;
export const PROJECT_TEAM_CONFIG_DIRNAME = '.pilotdeck';
export const PROJECT_TEAM_CONFIG_FILENAME = 'project-team.json';
export const INITIAL_PROJECT_TEAM_REVISION = '0';
export const PROJECT_TEAM_ROLES = Object.freeze([
    'commander',
    'executor',
    'reviewer',
    'supervisor',
    'inspector',
]);
export const PROJECT_TEAM_MAX_AGENTS = 32;
export const PROJECT_TEAM_MAX_FILE_BYTES = 256 * 1024;
export const PROJECT_TEAM_MAX_TOOL_ENTRIES = 200;

const AGENT_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
const MODEL_PROVIDER_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
const MODEL_ID_PATTERN = /^[A-Za-z0-9._:/-]{1,128}$/;
const REVISION_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const SECRET_KEY_PATTERN = /(api[-_]?key|secret|token|password|passphrase|credential)/i;
// Tool entries reuse the permission system syntax: a tool name (`read_file`),
// a tool group (`mcp:github`) or a command scoped pattern (`bash:git log:*`).
const TOOL_NAME_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
const TOOL_SCOPE_PATTERN = /^[A-Za-z0-9_.\-/* ]*(:\*)?$/;

function isValidToolEntry(entry) {
    if (typeof entry !== 'string') return false;
    const value = entry.trim();
    if (!value || value.length > 200) return false;
    const separator = value.indexOf(':');
    if (separator === -1) return TOOL_NAME_PATTERN.test(value);
    return TOOL_NAME_PATTERN.test(value.slice(0, separator))
        && TOOL_SCOPE_PATTERN.test(value.slice(separator + 1));
}

export const PROJECT_TEAM_TOOL_ACCESS_MODES = Object.freeze(['allow-list', 'all']);
export const PROJECT_TEAM_NETWORK_MODES = Object.freeze(['none', 'ask', 'allow']);
export const PROJECT_TEAM_WRITE_SCOPES = Object.freeze(['read-only', 'project', 'ask']);
export const PROJECT_TEAM_COLLABORATION_MODES = Object.freeze(['manual', 'commander', 'automated']);

/** Collaboration mode used when a team does not declare its own. */
export const DEFAULT_PROJECT_TEAM_COLLABORATION = Object.freeze({ mode: 'manual' });

/** Permissions applied when an agent does not declare its own. */
export const DEFAULT_AGENT_PERMISSIONS = Object.freeze({
    toolAccess: 'all',
    allowedTools: [],
    deniedTools: [],
    network: 'ask',
    writeScope: 'project',
    requireApproval: true,
});

const AGENT_FIELDS = Object.freeze([
    'id',
    'name',
    'description',
    'role',
    'roleDefinition',
    'model',
    'enabled',
    'permissions',
    'reportsTo',
]);
const PAYLOAD_FIELDS = Object.freeze(['version', 'revision', 'agents', 'collaboration']);
const MODEL_FIELDS = Object.freeze(['provider', 'model']);
const COLLABORATION_FIELDS = Object.freeze(['mode']);
const PERMISSION_FIELDS = Object.freeze([
    'toolAccess',
    'allowedTools',
    'deniedTools',
    'network',
    'writeScope',
    'requireApproval',
]);

// Per-project write queue. Serializes read-modify-write cycles inside this
// process so two concurrent PUTs cannot both pass the revision check.
const writeQueues = new Map();

export class ProjectTeamConfigError extends Error {
    constructor(message, { statusCode = 400, code = 'PROJECT_TEAM_ERROR' } = {}) {
        super(message);
        this.name = 'ProjectTeamConfigError';
        this.statusCode = statusCode;
        this.code = code;
    }
}

function isPlainObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function createRevision() {
    return crypto.randomBytes(16).toString('hex');
}

function configDirectory(root) {
    return path.join(root, PROJECT_TEAM_CONFIG_DIRNAME);
}

function configFilePath(root) {
    return path.join(configDirectory(root), PROJECT_TEAM_CONFIG_FILENAME);
}

/**
 * Collect every key in the payload that looks like a credential. The schema
 * already rejects unknown fields, this is a second line of defence so a
 * future schema addition cannot silently start persisting secrets.
 */
function findSecretKeys(value, trail = []) {
    if (Array.isArray(value)) {
        return value.flatMap((entry, index) => findSecretKeys(entry, [...trail, index]));
    }
    if (!isPlainObject(value)) return [];
    const found = [];
    for (const [key, entry] of Object.entries(value)) {
        const nextTrail = [...trail, key];
        if (SECRET_KEY_PATTERN.test(key)) found.push(nextTrail.join('.'));
        found.push(...findSecretKeys(entry, nextTrail));
    }
    return found;
}

function validateToolEntries(entries, label, errors) {
    if (!Array.isArray(entries)) {
        errors.push(`${label} must be an array of strings.`);
        return;
    }
    if (entries.length > PROJECT_TEAM_MAX_TOOL_ENTRIES) {
        errors.push(`${label} must contain at most ${PROJECT_TEAM_MAX_TOOL_ENTRIES} entries.`);
    }
    entries.forEach((entry, index) => {
        if (!isValidToolEntry(entry)) {
            errors.push(
                `${label}[${index}] must be a tool name (read_file), a tool group (mcp:github) `
                + 'or a scoped pattern (bash:git log:*).',
            );
        }
    });
}

/**
 * Tool authorization of a single agent. The shape mirrors the permission
 * system entries so the values can be replayed as permission rules later.
 */
function validatePermissions(permissions, prefix) {
    const errors = [];

    if (!isPlainObject(permissions)) {
        errors.push(`${prefix} must be an object.`);
        return errors;
    }

    const unknown = Object.keys(permissions).filter((key) => !PERMISSION_FIELDS.includes(key));
    if (unknown.length > 0) {
        errors.push(`${prefix} has unknown field(s): ${unknown.join(', ')}.`);
    }

    if (!PROJECT_TEAM_TOOL_ACCESS_MODES.includes(permissions.toolAccess)) {
        errors.push(`${prefix}.toolAccess must be one of: ${PROJECT_TEAM_TOOL_ACCESS_MODES.join(', ')}.`);
    }
    if (!PROJECT_TEAM_NETWORK_MODES.includes(permissions.network)) {
        errors.push(`${prefix}.network must be one of: ${PROJECT_TEAM_NETWORK_MODES.join(', ')}.`);
    }
    if (!PROJECT_TEAM_WRITE_SCOPES.includes(permissions.writeScope)) {
        errors.push(`${prefix}.writeScope must be one of: ${PROJECT_TEAM_WRITE_SCOPES.join(', ')}.`);
    }
    if (typeof permissions.requireApproval !== 'boolean') {
        errors.push(`${prefix}.requireApproval must be a boolean.`);
    }

    validateToolEntries(permissions.allowedTools, `${prefix}.allowedTools`, errors);
    validateToolEntries(permissions.deniedTools, `${prefix}.deniedTools`, errors);

    return errors;
}

function validateCollaboration(collaboration, prefix) {
    const errors = [];

    if (!isPlainObject(collaboration)) {
        errors.push(`${prefix} must be an object.`);
        return errors;
    }

    const unknown = Object.keys(collaboration).filter((key) => !COLLABORATION_FIELDS.includes(key));
    if (unknown.length > 0) {
        errors.push(`${prefix} has unknown field(s): ${unknown.join(', ')}.`);
    }
    if (!PROJECT_TEAM_COLLABORATION_MODES.includes(collaboration.mode)) {
        errors.push(`${prefix}.mode must be one of: ${PROJECT_TEAM_COLLABORATION_MODES.join(', ')}.`);
    }

    return errors;
}

function validateAgent(agent, index) {
    const errors = [];
    const prefix = `agents[${index}]`;

    if (!isPlainObject(agent)) {
        errors.push(`${prefix} must be an object.`);
        return errors;
    }

    const unknown = Object.keys(agent).filter((key) => !AGENT_FIELDS.includes(key));
    if (unknown.length > 0) {
        errors.push(`${prefix} has unknown field(s): ${unknown.join(', ')}.`);
    }

    if (typeof agent.id !== 'string' || !AGENT_ID_PATTERN.test(agent.id)) {
        errors.push(`${prefix}.id must match ${AGENT_ID_PATTERN.source}.`);
    }
    if (typeof agent.name !== 'string' || agent.name.trim() === '' || agent.name.length > 120) {
        errors.push(`${prefix}.name must be a non-empty string of at most 120 characters.`);
    }
    if (typeof agent.description !== 'string' || agent.description.length > 1000) {
        errors.push(`${prefix}.description must be a string of at most 1000 characters.`);
    }
    if (typeof agent.role !== 'string' || !PROJECT_TEAM_ROLES.includes(agent.role)) {
        errors.push(`${prefix}.role must be one of: ${PROJECT_TEAM_ROLES.join(', ')}.`);
    }
    if (typeof agent.roleDefinition !== 'string' || agent.roleDefinition.length > 4000) {
        errors.push(`${prefix}.roleDefinition must be a string of at most 4000 characters.`);
    }
    if (agent.model !== null && !isPlainObject(agent.model)) {
        errors.push(`${prefix}.model must be null or an object with provider and model.`);
    } else if (isPlainObject(agent.model)) {
        const unknownModel = Object.keys(agent.model).filter((key) => !MODEL_FIELDS.includes(key));
        if (unknownModel.length > 0) {
            errors.push(`${prefix}.model has unknown field(s): ${unknownModel.join(', ')}.`);
        }
        if (typeof agent.model.provider !== 'string'
            || !MODEL_PROVIDER_PATTERN.test(agent.model.provider)) {
            errors.push(`${prefix}.model.provider must match ${MODEL_PROVIDER_PATTERN.source}.`);
        }
        if (typeof agent.model.model !== 'string' || !MODEL_ID_PATTERN.test(agent.model.model)) {
            errors.push(`${prefix}.model.model must match ${MODEL_ID_PATTERN.source}.`);
        }
    }
    if (typeof agent.enabled !== 'boolean') {
        errors.push(`${prefix}.enabled must be a boolean.`);
    }
    if (agent.permissions !== undefined) {
        errors.push(...validatePermissions(agent.permissions, `${prefix}.permissions`));
    }
    if (agent.reportsTo !== undefined && agent.reportsTo !== null) {
        if (typeof agent.reportsTo !== 'string' || !AGENT_ID_PATTERN.test(agent.reportsTo)) {
            errors.push(`${prefix}.reportsTo must be null or an agent id.`);
        } else if (agent.reportsTo === agent.id) {
            errors.push(`${prefix}.reportsTo must not point at the agent itself.`);
        }
    }

    return errors;
}

function normalizeToolEntries(entries) {
    if (!Array.isArray(entries)) return [];
    const seen = new Set();
    const normalized = [];
    for (const entry of entries) {
        if (typeof entry !== 'string') continue;
        const trimmed = entry.trim();
        if (!trimmed || seen.has(trimmed)) continue;
        seen.add(trimmed);
        normalized.push(trimmed);
    }
    return normalized;
}

/** Fill in the permission defaults so every stored agent has a full shape. */
export function normalizeAgentPermissions(permissions) {
    if (!isPlainObject(permissions)) {
        return { ...DEFAULT_AGENT_PERMISSIONS };
    }
    return {
        toolAccess: PROJECT_TEAM_TOOL_ACCESS_MODES.includes(permissions.toolAccess)
            ? permissions.toolAccess
            : DEFAULT_AGENT_PERMISSIONS.toolAccess,
        allowedTools: normalizeToolEntries(permissions.allowedTools),
        deniedTools: normalizeToolEntries(permissions.deniedTools),
        network: PROJECT_TEAM_NETWORK_MODES.includes(permissions.network)
            ? permissions.network
            : DEFAULT_AGENT_PERMISSIONS.network,
        writeScope: PROJECT_TEAM_WRITE_SCOPES.includes(permissions.writeScope)
            ? permissions.writeScope
            : DEFAULT_AGENT_PERMISSIONS.writeScope,
        requireApproval: typeof permissions.requireApproval === 'boolean'
            ? permissions.requireApproval
            : DEFAULT_AGENT_PERMISSIONS.requireApproval,
    };
}

function normalizeAgent(agent) {
    return {
        id: agent.id,
        name: agent.name,
        description: agent.description,
        role: agent.role,
        roleDefinition: agent.roleDefinition,
        model: isPlainObject(agent.model)
            ? { provider: agent.model.provider, model: agent.model.model }
            : null,
        enabled: agent.enabled,
        permissions: normalizeAgentPermissions(agent.permissions),
        reportsTo: typeof agent.reportsTo === 'string' ? agent.reportsTo : null,
    };
}

/** Fill in the collaboration defaults of a team. */
export function normalizeTeamCollaboration(collaboration) {
    if (!isPlainObject(collaboration)) {
        return { ...DEFAULT_PROJECT_TEAM_COLLABORATION };
    }
    return {
        mode: PROJECT_TEAM_COLLABORATION_MODES.includes(collaboration.mode)
            ? collaboration.mode
            : DEFAULT_PROJECT_TEAM_COLLABORATION.mode,
    };
}

/**
 * Validate a project team payload. The same rules apply to the PUT body and
 * to the stored file, so a hand-edited file is validated on read as well.
 */
export function validateProjectTeamPayload(payload) {
    const errors = [];

    if (!isPlainObject(payload)) {
        return { valid: false, errors: ['Payload must be a JSON object.'] };
    }

    const unknownTop = Object.keys(payload).filter((key) => !PAYLOAD_FIELDS.includes(key));
    if (unknownTop.length > 0) {
        errors.push(`Unknown field(s): ${unknownTop.join(', ')}.`);
    }

    if (payload.version !== PROJECT_TEAM_CONFIG_VERSION) {
        errors.push(`version must be ${PROJECT_TEAM_CONFIG_VERSION}.`);
    }

    if (typeof payload.revision !== 'string' || !REVISION_PATTERN.test(payload.revision)) {
        errors.push('revision must be a string of 1-64 characters (A-Z, a-z, 0-9, "-", "_").');
    }

    if (!Array.isArray(payload.agents)) {
        errors.push('agents must be an array.');
    } else {
        if (payload.agents.length > PROJECT_TEAM_MAX_AGENTS) {
            errors.push(`agents must contain at most ${PROJECT_TEAM_MAX_AGENTS} entries.`);
        }
        const seenIds = new Set();
        payload.agents.forEach((agent, index) => {
            errors.push(...validateAgent(agent, index));
            if (isPlainObject(agent) && typeof agent.id === 'string') {
                if (seenIds.has(agent.id)) {
                    errors.push(`agents[${index}].id duplicates another agent id.`);
                }
                seenIds.add(agent.id);
            }
        });

        // A coordinator reference must point at an agent of the same team.
        payload.agents.forEach((agent, index) => {
            if (!isPlainObject(agent)) return;
            const coordinator = agent.reportsTo;
            if (typeof coordinator !== 'string' || coordinator === '') return;
            if (!seenIds.has(coordinator)) {
                errors.push(`agents[${index}].reportsTo must reference an agent of the same team.`);
            }
        });
    }

    if (payload.collaboration !== undefined) {
        errors.push(...validateCollaboration(payload.collaboration, 'collaboration'));
    }

    const secretPaths = findSecretKeys(payload);
    if (secretPaths.length > 0) {
        errors.push(`Secret-like field(s) are not allowed: ${secretPaths.join(', ')}.`);
    }

    return { valid: errors.length === 0, errors };
}

/**
 * Roots of locally registered projects, read from the `.cwd` markers the UI
 * writes into `~/.pilotdeck/projects/<id>/.cwd`.
 */
export async function readRegisteredMarkerRoots(env = process.env) {
    const pilotHome = resolvePilotHome(env);
    const projectsDir = path.join(pilotHome, 'projects');
    const roots = [];

    let entries = [];
    try {
        entries = await fs.readdir(projectsDir, { withFileTypes: true });
    } catch {
        return roots;
    }

    for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        try {
            const marker = (await fs.readFile(path.join(projectsDir, entry.name, '.cwd'), 'utf8')).trim();
            if (marker) roots.push(marker);
        } catch {
            // No marker for this project id — the gateway snapshot may still
            // know about it.
        }
    }

    return roots;
}

/**
 * All roots that may receive a project team configuration: local markers plus
 * the gateway project snapshot (best effort — the gateway may be down).
 */
export async function listRegisteredProjectRoots({ env = process.env, snapshotProvider = null } = {}) {
    const roots = new Map();

    for (const root of await readRegisteredMarkerRoots(env)) {
        roots.set(path.resolve(root), root);
    }

    if (snapshotProvider) {
        let projects = [];
        try {
            projects = await snapshotProvider();
        } catch {
            projects = [];
        }
        for (const project of Array.isArray(projects) ? projects : []) {
            if (!project || project.kind === 'general') continue;
            const fullPath = project.fullPath || project.path;
            if (typeof fullPath === 'string' && fullPath) {
                roots.set(path.resolve(fullPath), fullPath);
            }
        }
    }

    return [...roots.values()];
}

/**
 * Resolve the caller supplied root to a registered project root. Only an
 * exact match is accepted — nested directories of a project are rejected.
 */
export async function resolveRegisteredProjectRoot(projectRoot, {
    env = process.env,
    snapshotProvider = null,
    registeredRoots = null,
} = {}) {
    if (typeof projectRoot !== 'string' || projectRoot.trim() === '') {
        throw new ProjectTeamConfigError('projectRoot query parameter is required.', {
            statusCode: 400,
            code: 'PROJECT_ROOT_REQUIRED',
        });
    }

    const candidate = projectRoot.trim();
    if (!path.isAbsolute(candidate)) {
        throw new ProjectTeamConfigError('projectRoot must be an absolute path.', {
            statusCode: 400,
            code: 'PROJECT_ROOT_INVALID',
        });
    }

    // A matching local marker is sufficient; avoid waiting on a disconnected
    // gateway. If it does not match, consult the gateway too: it may register
    // additional projects even when other local markers exist.
    const localRoots = registeredRoots ?? await listRegisteredProjectRoots({ env });
    const resolvedCandidate = path.resolve(candidate);
    const roots = registeredRoots || !snapshotProvider || localRoots.some((root) => path.resolve(root) === resolvedCandidate)
        ? localRoots
        : await listRegisteredProjectRoots({ env, snapshotProvider });

    let candidateReal = null;
    try {
        candidateReal = await fs.realpath(resolvedCandidate);
    } catch {
        candidateReal = null;
    }

    for (const root of roots) {
        if (typeof root !== 'string' || !root) continue;
        const resolvedRoot = path.resolve(root);
        if (resolvedRoot === resolvedCandidate) {
            return resolvedRoot;
        }
        if (candidateReal) {
            let rootReal = null;
            try {
                rootReal = await fs.realpath(resolvedRoot);
            } catch {
                rootReal = null;
            }
            if (rootReal && rootReal === candidateReal) return resolvedRoot;
        }
    }

    throw new ProjectTeamConfigError('projectRoot is not a registered project root.', {
        statusCode: 404,
        code: 'PROJECT_NOT_REGISTERED',
    });
}

/**
 * Guard the `.pilotdeck` directory: it must be a real directory (never a
 * symlink) and must stay inside the project root. When `create` is false a
 * missing directory is not an error — reads must not create anything.
 */
async function assertDirectoryIsSafe(root, directory, { create = false } = {}) {
    let stats = null;
    try {
        stats = await fs.lstat(directory);
    } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
    }

    if (!stats) {
        if (!create) return false;
        await fs.mkdir(directory, { recursive: true });
        stats = await fs.lstat(directory);
    }

    if (stats.isSymbolicLink()) {
        throw new ProjectTeamConfigError(
            `Refusing to use the symlinked ${PROJECT_TEAM_CONFIG_DIRNAME} directory.`,
            { statusCode: 422, code: 'PROJECT_TEAM_CONFIG_SYMLINK' },
        );
    }
    if (!stats.isDirectory()) {
        throw new ProjectTeamConfigError(
            `${PROJECT_TEAM_CONFIG_DIRNAME} exists but is not a directory.`,
            { statusCode: 422, code: 'PROJECT_TEAM_CONFIG_NOT_A_DIRECTORY' },
        );
    }

    const [rootReal, directoryReal] = await Promise.all([
        fs.realpath(root),
        fs.realpath(directory),
    ]);
    if (!isPathInsideOrEqual(rootReal, directoryReal)) {
        throw new ProjectTeamConfigError(
            'Refusing to write outside the project root.',
            { statusCode: 422, code: 'PROJECT_TEAM_CONFIG_OUTSIDE_ROOT' },
        );
    }

    return true;
}

async function assertFileIsNotSymlink(filePath) {
    let stats = null;
    try {
        stats = await fs.lstat(filePath);
    } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
        return;
    }
    if (stats.isSymbolicLink()) {
        throw new ProjectTeamConfigError(
            `Refusing to write through the symlinked ${PROJECT_TEAM_CONFIG_FILENAME} file.`,
            { statusCode: 422, code: 'PROJECT_TEAM_CONFIG_SYMLINK' },
        );
    }
}

function parseStoredConfig(raw, filePath) {
    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch (error) {
        throw new ProjectTeamConfigError(
            `Stored project team configuration is corrupted (invalid JSON): ${error.message}`,
            { statusCode: 422, code: 'PROJECT_TEAM_CONFIG_CORRUPTED' },
        );
    }

    const validation = validateProjectTeamPayload(parsed);
    if (!validation.valid) {
        throw new ProjectTeamConfigError(
            `Stored project team configuration is corrupted: ${validation.errors.join(' ')}`,
            { statusCode: 422, code: 'PROJECT_TEAM_CONFIG_CORRUPTED' },
        );
    }

    return {
        version: parsed.version,
        revision: parsed.revision,
        collaboration: normalizeTeamCollaboration(parsed.collaboration),
        agents: parsed.agents.map(normalizeAgent),
    };
}

/**
 * Read the stored configuration. Returns the initial (empty) configuration
 * when nothing is stored yet; throws when the stored file is corrupted.
 */
async function readStoredConfig(root) {
    const filePath = configFilePath(root);
    await assertFileIsNotSymlink(filePath);

    let raw;
    try {
        raw = await fs.readFile(filePath, 'utf8');
    } catch (error) {
        if (error?.code === 'ENOENT') return null;
        throw error;
    }

    if (Buffer.byteLength(raw, 'utf8') > PROJECT_TEAM_MAX_FILE_BYTES) {
        throw new ProjectTeamConfigError(
            'Stored project team configuration is corrupted (file is too large).',
            { statusCode: 422, code: 'PROJECT_TEAM_CONFIG_CORRUPTED' },
        );
    }

    return parseStoredConfig(raw, filePath);
}

/**
 * Read the project team configuration of a registered project.
 */
export async function readProjectTeamConfig({
    projectRoot,
    env = process.env,
    snapshotProvider = null,
    registeredRoots = null,
} = {}) {
    const root = await resolveRegisteredProjectRoot(projectRoot, {
        env,
        snapshotProvider,
        registeredRoots,
    });
    await assertDirectoryIsSafe(root, configDirectory(root), { create: false });

    const stored = await readStoredConfig(root);
    if (!stored) {
        return {
            version: PROJECT_TEAM_CONFIG_VERSION,
            revision: INITIAL_PROJECT_TEAM_REVISION,
            collaboration: { ...DEFAULT_PROJECT_TEAM_COLLABORATION },
            agents: [],
        };
    }
    return stored;
}

function enqueueWrite(root, task) {
    const previous = writeQueues.get(root) ?? Promise.resolve();
    const run = previous.then(task, task);
    writeQueues.set(root, run.catch(() => undefined));
    return run;
}

async function syncDirectory(directory) {
    let handle = null;
    try {
        handle = await fs.open(directory, 'r');
        await handle.sync();
    } catch {
        // Directory fsync is not supported everywhere; the rename itself is
        // still atomic.
    } finally {
        await handle?.close().catch(() => undefined);
    }
}

/**
 * Persist a project team configuration. The revision must match the stored
 * one (or the initial revision for a project without a configuration yet),
 * otherwise the write is rejected as a conflict.
 */
export async function writeProjectTeamConfig({
    projectRoot,
    revision,
    agents,
    collaboration,
    env = process.env,
    snapshotProvider = null,
    registeredRoots = null,
} = {}) {
    const root = await resolveRegisteredProjectRoot(projectRoot, {
        env,
        snapshotProvider,
        registeredRoots,
    });

    const validation = validateProjectTeamPayload({
        version: PROJECT_TEAM_CONFIG_VERSION,
        revision,
        agents,
        collaboration,
    });
    if (!validation.valid) {
        throw new ProjectTeamConfigError(validation.errors.join(' '), {
            statusCode: 400,
            code: 'PROJECT_TEAM_VALIDATION_FAILED',
        });
    }

    return enqueueWrite(root, async () => {
        const directory = configDirectory(root);
        const filePath = configFilePath(root);

        await assertDirectoryIsSafe(root, directory, { create: true });
        await assertFileIsNotSymlink(filePath);

        const stored = await readStoredConfig(root);
        const currentRevision = stored ? stored.revision : INITIAL_PROJECT_TEAM_REVISION;
        if (currentRevision !== revision) {
            throw new ProjectTeamConfigError(
                'Project team configuration was changed by another writer. Reload it and try again.',
                { statusCode: 409, code: 'PROJECT_TEAM_REVISION_CONFLICT' },
            );
        }

        const next = {
            version: PROJECT_TEAM_CONFIG_VERSION,
            revision: createRevision(),
            collaboration: normalizeTeamCollaboration(collaboration),
            agents: agents.map(normalizeAgent),
        };
        const payload = `${JSON.stringify(next, null, 2)}\n`;
        if (Buffer.byteLength(payload, 'utf8') > PROJECT_TEAM_MAX_FILE_BYTES) {
            throw new ProjectTeamConfigError(
                'Project team configuration is too large to store.',
                { statusCode: 413, code: 'PROJECT_TEAM_CONFIG_TOO_LARGE' },
            );
        }

        const tempPath = path.join(
            directory,
            `.${PROJECT_TEAM_CONFIG_FILENAME}.${process.pid}.${crypto.randomUUID()}.tmp`,
        );

        try {
            const handle = await fs.open(tempPath, 'wx', 0o600);
            try {
                await handle.writeFile(payload, 'utf8');
                await handle.sync();
            } finally {
                await handle.close();
            }

            // Re-check the revision right before the rename so a concurrent
            // writer (in another process) cannot be overwritten silently.
            const latest = await readStoredConfig(root);
            const latestRevision = latest ? latest.revision : INITIAL_PROJECT_TEAM_REVISION;
            if (latestRevision !== revision) {
                throw new ProjectTeamConfigError(
                    'Project team configuration was changed by another writer. Reload it and try again.',
                    { statusCode: 409, code: 'PROJECT_TEAM_REVISION_CONFLICT' },
                );
            }

            await assertFileIsNotSymlink(filePath);
            await fs.rename(tempPath, filePath);
            await syncDirectory(directory);
        } finally {
            await fs.rm(tempPath, { force: true }).catch(() => undefined);
        }

        try {
            ensurePilotProjectGitIgnore(root, false);
        } catch {
            // The .gitignore is a convenience only — never fail a write for it.
        }

        return next;
    });
}
