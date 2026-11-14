/**
 * Commander-driven task loop — the missing "judge and keep going" layer.
 *
 * Why this file exists
 * --------------------
 * PilotV already has roles (`commander` / `executor` / `reviewer` /
 * `supervisor`) and a collaboration setting, but the runtime only ever ran
 * *one* extra reviewer turn after a completed turn (see
 * `projectTeamCollaboration.js`). Nothing watched the result of a turn and
 * decided "this is not finished, here is the next instruction". So a task
 * stopped as soon as the model produced a reply without a tool call, and the
 * only one who could resume it was the human.
 *
 * This module is the decision core of the fix. It is deliberately pure: no
 * I/O, no gateway, no clock of its own. The bridge feeds it evidence and a
 * verdict, and it answers "dispatch again / finish / wait for the human /
 * stop". That keeps the loop testable without a gateway and keeps the
 * bridging code honest.
 *
 * Wire format
 * -----------
 * The commander ends its judgement turn with a single marker line:
 *
 *     <<PILOTV_VERDICT>>{"status":"continue","next":"...","assignee":"worker"}
 *
 * Chosen over a side-channel JSON file because PilotV's product rule is
 * "明文可审计": the verdict, its reason and the next instruction all land in
 * the same transcript the human is already reading.
 */

/** Marker the commander must emit before its verdict JSON. */
export const COMMANDER_VERDICT_MARKER = '<<PILOTV_VERDICT>>';

/** Verdict statuses the loop understands. */
export const COMMANDER_VERDICT_STATUSES = Object.freeze([
    'done',
    'continue',
    'blocked',
    'needs_user',
]);

/**
 * Defaults chosen so a stuck loop costs a bounded amount of money and time.
 * `maxIterations` counts judgement rounds, not single turns: in delegated
 * mode one iteration is (worker turn + commander judgement turn).
 *
 * 2026-11-14：原默认 6 轮 / 45 分钟与单 turn 护栏的 45 分钟叠加，导致长 CAD
 * 任务必然在第一个 turn 里被双重截断。现在单 turn 护栏改为「无进展才停」，
 * 这里同步放宽到 12 轮 / 4 小时；真正失控仍由 turnStallGuard 的 idle /
 * token / 重复检测兜住。可用环境变量覆盖，无需改代码：
 *   PILOTV_COMMANDER_MAX_ITERATIONS
 *   PILOTV_COMMANDER_MAX_WALL_CLOCK_MS
 *   PILOTV_COMMANDER_MAX_INVALID_VERDICTS
 */
function positiveIntFromEnv(name, fallback) {
    const raw = String(process.env?.[name] ?? '').trim();
    if (!raw) return fallback;
    const value = Number.parseInt(raw, 10);
    return Number.isFinite(value) && value > 0 ? value : fallback;
}

export const COMMANDER_DEFAULT_LIMITS = Object.freeze({
    maxIterations: positiveIntFromEnv('PILOTV_COMMANDER_MAX_ITERATIONS', 12),
    maxWallClockMs: positiveIntFromEnv('PILOTV_COMMANDER_MAX_WALL_CLOCK_MS', 4 * 60 * 60 * 1000),
    /** Same normalised instruction seen this many times means no progress. */
    maxInstructionRepeats: 2,
    /** Unreadable verdicts tolerated before we ask the human. 原为 2，长任务里判定轮容易被误停。 */
    maxInvalidVerdicts: positiveIntFromEnv('PILOTV_COMMANDER_MAX_INVALID_VERDICTS', 3),
});

/** Trim, collapse whitespace, drop trailing punctuation — progress fingerprint. */
export function normalizeInstruction(text) {
    return String(text ?? '')
        .replace(/\s+/g, ' ')
        .replace(/^[\s\-*0-9.、）)]+/, '')
        .replace(/[。．.；;，,！!？?\s]+$/g, '')
        .trim()
        .toLowerCase();
}

/**
 * Pull the first balanced JSON object out of `text` starting at `from`.
 * Returns null when braces never balance (truncated output is common when a
 * model hits its output cap mid-JSON).
 */
function sliceBalancedObject(text, from = 0) {
    const start = text.indexOf('{', from);
    if (start === -1) return null;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < text.length; i += 1) {
        const ch = text[i];
        if (inString) {
            if (escaped) escaped = false;
            else if (ch === '\\') escaped = true;
            else if (ch === '"') inString = false;
            continue;
        }
        if (ch === '"') inString = true;
        else if (ch === '{') depth += 1;
        else if (ch === '}') {
            depth -= 1;
            if (depth === 0) return text.slice(start, i + 1);
        }
    }
    return null;
}

function tryParseObject(candidate) {
    if (!candidate) return null;
    try {
        const value = JSON.parse(candidate);
        return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
    } catch {
        return null;
    }
}

/**
 * Find the verdict payload in an assistant message.
 *
 * Accepts, in order of confidence:
 *   1. `<<PILOTV_VERDICT>>{...}` (and `<<PILOTV_VERDICT>> {...}`, fenced).
 *   2. A fenced ```json block whose body has a `status` field.
 *   3. The last balanced `{...}` in the text that has a `status` field.
 * Anything else is reported as unreadable — never guessed.
 */
export function extractVerdictPayload(text) {
    const source = String(text ?? '');
    if (!source.trim()) return null;

    const markerAt = source.lastIndexOf(COMMANDER_VERDICT_MARKER);
    if (markerAt !== -1) {
        const direct = tryParseObject(sliceBalancedObject(source, markerAt));
        if (direct) return direct;
    }

    const fence = /```(?:json)?\s*([\s\S]*?)```/gi;
    let match;
    let lastFenced = null;
    while ((match = fence.exec(source)) !== null) {
        const parsed = tryParseObject(sliceBalancedObject(match[1], 0));
        if (parsed && typeof parsed.status === 'string') lastFenced = parsed;
    }
    if (lastFenced) return lastFenced;

    // Last resort: walk every object and keep the last one with a status.
    let cursor = 0;
    let lastWithStatus = null;
    for (;;) {
        const candidate = sliceBalancedObject(source, cursor);
        if (!candidate) break;
        const parsed = tryParseObject(candidate);
        if (parsed && typeof parsed.status === 'string') lastWithStatus = parsed;
        const end = source.indexOf(candidate, cursor) + candidate.length;
        cursor = end > cursor ? end : cursor + 1;
        if (cursor >= source.length) break;
    }
    return lastWithStatus;
}

/**
 * Parse a commander message into a verdict.
 *
 * @returns {{
 *   ok: boolean,
 *   status: 'done'|'continue'|'blocked'|'needs_user'|null,
 *   summary: string,
 *   nextInstruction: string,
 *   assignee: string|null,
 *   reason: string,
 *   raw: object|null,
 * }}
 */
export function parseVerdict(text) {
    const payload = extractVerdictPayload(text);
    if (!payload) {
        return {
            ok: false,
            status: null,
            summary: '',
            nextInstruction: '',
            assignee: null,
            reason: 'verdict_marker_missing',
            raw: null,
        };
    }
    const status = String(payload.status ?? '').trim().toLowerCase();
    if (!COMMANDER_VERDICT_STATUSES.includes(status)) {
        return {
            ok: false,
            status: null,
            summary: '',
            nextInstruction: '',
            assignee: null,
            reason: `verdict_status_invalid:${status || 'empty'}`,
            raw: payload,
        };
    }
    const nextInstruction = String(
        payload.next
        ?? payload.nextInstruction
        ?? payload.instruction
        ?? '',
    ).trim();
    return {
        ok: true,
        status,
        summary: String(payload.summary ?? payload.reason_text ?? '').trim(),
        nextInstruction,
        assignee: payload.assignee ? String(payload.assignee) : null,
        reason: String(payload.reason ?? '').trim(),
        raw: payload,
    };
}

/**
 * Stable fingerprint used to detect "the commander keeps saying the same
 * thing" — the practical shape of a stuck loop.
 */
export function progressKey(instruction) {
    const normalised = normalizeInstruction(instruction);
    if (!normalised) return '';
    // Cheap 53-bit FNV-1a; collisions are harmless here (worst case we stop
    // slightly early on genuinely different instructions).
    let hash = 0xcbf29ce484222325n;
    for (let i = 0; i < normalised.length; i += 1) {
        hash ^= BigInt(normalised.charCodeAt(i));
        hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
    }
    return hash.toString(16);
}

/**
 * Create the per-session loop state. Kept in memory by the bridge: a restart
 * must NOT resume a loop on its own, because the human may have moved on.
 */
export function createCommanderState({
    sessionKey,
    goal,
    acceptance = [],
    mode = 'self',
    commanderId = null,
    workerId = null,
    limits = {},
    now = Date.now(),
} = {}) {
    return {
        version: 1,
        sessionKey: sessionKey ?? null,
        goal: String(goal ?? '').trim(),
        acceptance: Array.isArray(acceptance) ? acceptance.filter(Boolean).map(String) : [],
        mode: mode === 'delegated' ? 'delegated' : 'self',
        commanderId,
        workerId,
        limits: { ...COMMANDER_DEFAULT_LIMITS, ...limits },
        startedAt: now,
        iteration: 0,
        invalidVerdicts: 0,
        instructionCounts: Object.create(null),
        lastInstruction: '',
        verdicts: [],
        status: 'running',
        stopReason: null,
    };
}

/** Record what was dispatched so progress detection has something to compare. */
export function noteDispatch(state, action, { now = Date.now() } = {}) {
    const instruction = String(action?.instruction ?? '').trim();
    const key = progressKey(instruction);
    if (key) {
        state.instructionCounts[key] = (state.instructionCounts[key] || 0) + 1;
    }
    state.lastInstruction = instruction;
    state.iteration += 1;
    state.lastDispatchedAt = now;
    return state;
}

/**
 * Decide what happens after a turn.
 *
 * Guard order matters and is deliberate:
 *   1. The human always wins. A queued message or a fresh user turn ends the
 *      loop immediately — we never compete with a person for the session.
 *   2. An unreadable verdict is retried a bounded number of times, then the
 *      human is asked. We do not invent a verdict.
 *   3. `done` finishes. Note that this trusts the commander: the caller must
 *      feed it objective evidence (git status, test exit codes) so "done" is
 *      not just self-praise. See `summarizeEvidence`.
 *   4. `blocked` / `needs_user` surface to the human instead of burning turns.
 *   5. Budgets (iterations, wall clock, repeated instruction) stop the loop
 *      and leave the reason on the transcript.
 *
 * @returns {{type:'dispatch'|'finish'|'wait_user'|'stop', ...}}
 */
export function decideNextAction(state, verdict, { now = Date.now(), userTookOver = false } = {}) {
    const limits = state.limits ?? COMMANDER_DEFAULT_LIMITS;

    if (userTookOver) {
        return { type: 'stop', reason: 'user_took_over' };
    }

    if (!verdict || verdict.ok !== true) {
        state.invalidVerdicts += 1;
        if (state.invalidVerdicts >= limits.maxInvalidVerdicts) {
            return {
                type: 'wait_user',
                reason: verdict?.reason || 'verdict_unreadable',
            };
        }
        return {
            type: 'dispatch',
            reason: 'verdict_unreadable_retry',
            assignee: currentAssignee(state),
            instruction: state.lastInstruction || state.goal,
            iteration: state.iteration + 1,
        };
    }

    if (verdict.status === 'done') {
        state.invalidVerdicts = 0;
        return { type: 'finish', summary: verdict.summary, verdict };
    }

    if (verdict.status === 'blocked' || verdict.status === 'needs_user') {
        state.invalidVerdicts = 0;
        return {
            type: 'wait_user',
            reason: verdict.reason || verdict.status,
            summary: verdict.summary,
            verdict,
        };
    }

    // status === 'continue'
    if (state.iteration >= limits.maxIterations) {
        return { type: 'stop', reason: 'max_iterations', verdict };
    }
    if (now - state.startedAt > limits.maxWallClockMs) {
        return { type: 'stop', reason: 'time_budget', verdict };
    }

    const instruction = (verdict.nextInstruction || '').trim();
    if (!instruction) {
        state.invalidVerdicts += 1;
        if (state.invalidVerdicts >= limits.maxInvalidVerdicts) {
            return { type: 'wait_user', reason: 'next_instruction_missing', verdict };
        }
        return {
            type: 'dispatch',
            reason: 'next_instruction_missing_retry',
            assignee: currentAssignee(state),
            instruction: state.lastInstruction || state.goal,
            iteration: state.iteration + 1,
            verdict,
        };
    }

    const key = progressKey(instruction);
    const seen = key ? (state.instructionCounts[key] || 0) : 0;
    if (seen >= limits.maxInstructionRepeats) {
        return { type: 'stop', reason: 'no_progress', verdict };
    }

    state.invalidVerdicts = 0;
    return {
        type: 'dispatch',
        reason: 'continue',
        assignee: resolveAssignee(state, verdict.assignee),
        instruction,
        iteration: state.iteration + 1,
        verdict,
    };
}

function currentAssignee(state) {
    return state.mode === 'delegated' ? state.workerId : state.commanderId;
}

/**
 * The commander may name a teammate. Only an id it actually has (or the
 * configured worker) is honoured; anything else falls back instead of
 * dispatching to a non-existent agent.
 */
function resolveAssignee(state, requested) {
    if (state.mode !== 'delegated') return state.commanderId;
    if (!requested) return state.workerId;
    return requested;
}

/** Mark the loop finished so the caller can persist/teardown cleanly. */
export function settleCommanderState(state, action) {
    state.status = action.type === 'finish'
        ? 'done'
        : action.type === 'wait_user'
            ? 'waiting_user'
            : 'stopped';
    state.stopReason = action.reason ?? null;
    state.endedAt = Date.now();
    return state;
}

/**
 * One-line UI text. Chinese because that is the product language; keep it
 * short — it renders as a status chip, not a paragraph.
 */
export function describeAction(action, state) {
    switch (action.type) {
        case 'dispatch':
            return `指挥判定 #${action.iteration ?? state.iteration + 1}：任务未完成，继续派发。`;
        case 'finish':
            return `指挥判定：目标已达成，任务结束。${action.summary ? ` ${action.summary}` : ''}`.trim();
        case 'wait_user':
            return `指挥判定：需要人工介入（${action.reason}）。`;
        case 'stop':
            return `指挥循环已停止（${action.reason}）。`;
        default:
            return '指挥状态未知。';
    }
}

/**
 * Pull completion criteria out of the user's message when they wrote them down.
 *
 * A judge without criteria can only grade "does the reply look finished" —
 * which is exactly the failure we are fixing. Recognised shapes:
 *
 *     完成条件：
 *     - 手机宽度无横向滚动
 *     1. npm test 通过
 *
 * Also accepts 验收标准 / 验收条件 / acceptance. Returns [] when the user did
 * not state any; never invents criteria.
 */
export function extractAcceptance(text) {
    const lines = String(text ?? '').split(/\r?\n/);
    const marker = /(完成条件|验收标准|验收条件|验收|acceptance)\s*[:：]/i;
    const start = lines.findIndex((line) => marker.test(line));
    if (start === -1) return [];
    const items = [];
    for (const line of lines.slice(start + 1)) {
        const bullet = line.match(/^\s*(?:[-*•]|\d+[.、)])\s+(.*\S)\s*$/);
        if (bullet) {
            items.push(bullet[1].trim());
            continue;
        }
        if (!line.trim()) continue;
        break;
    }
    if (items.length === 0) {
        const match = lines[start].match(marker);
        const inline = match
            ? lines[start].slice(match.index + match[0].length).trim().replace(/^[，,]\s*/, '')
            : '';
        if (inline) items.push(inline);
    }
    return items.slice(0, 8);
}

/**
 * Build the judgement request appended to the commander's turn.
 *
 * Contract points that matter:
 *   - Evidence first, opinion second: the commander is told to read the
 *     concrete state before judging.
 *   - "done" must cite the acceptance criteria, not a feeling.
 *   - The machine-readable line is mandatory and comes last.
 */
export function buildJudgeRequest({
    goal,
    acceptance = [],
    iteration,
    evidence = {},
    mode = 'self',
    workerName = '',
} = {}) {
    const lines = [
        `【指挥判定 · 第 ${iteration} 轮】`,
        `目标：${String(goal ?? '').trim() || '（未记录）'}`,
    ];
    if (acceptance.length > 0) {
        lines.push('完成条件：');
        acceptance.forEach((item, index) => lines.push(`  ${index + 1}. ${item}`));
    }
    lines.push('', '当前实施情况（客观证据优先于自述）：');
    lines.push(evidence.lastAssistantText
        ? `- 上一轮回复要点：${truncate(evidence.lastAssistantText, 1200)}`
        : '- 上一轮没有可读回复');
    if (evidence.gitStatus) lines.push(`- 工作区改动：${truncate(evidence.gitStatus, 600)}`);
    if (evidence.gitDiffStat) lines.push(`- 改动统计：${truncate(evidence.gitDiffStat, 600)}`);
    if (Array.isArray(evidence.checks) && evidence.checks.length > 0) {
        for (const check of evidence.checks) {
            lines.push(`- 校验 \`${check.name}\`：exit=${check.exitCode}${check.summary ? ` ${truncate(check.summary, 300)}` : ''}`);
        }
    }
    if (Array.isArray(evidence.artifacts) && evidence.artifacts.length > 0) {
        lines.push(`- 产物：${evidence.artifacts.slice(0, 10).join('、')}`);
    }
    lines.push('', '请逐条对照完成条件判定，不要以「已回复用户」当作完成。');
    if (mode === 'delegated' && workerName) {
        lines.push(`若未完成，给出可以直接交给「${workerName}」执行的下一步指令（一条，具体可操作，不含寒暄）。`);
    } else {
        lines.push('若未完成，不要停在计划或说明上：给出下一步后立即继续执行，直到目标达成或确实需要我决定。');
    }
    lines.push(
        '',
        '回复最后一行必须是下面这一行（JSON 单行，不要换行、不要代码块）：',
        `${COMMANDER_VERDICT_MARKER}{"status":"done|continue|blocked|needs_user","summary":"一句话结论","next":"未完成时的下一步指令","assignee":"可选，成员 id"}`,
    );
    return lines.join('\n');
}

/** First instruction handed to the worker in delegated mode. */
export function buildWorkerDispatch({ goal, acceptance = [], instruction, iteration } = {}) {
    const lines = [
        `【指挥派发 · 第 ${iteration} 轮】`,
        `目标：${String(goal ?? '').trim() || '（未记录）'}`,
    ];
    if (acceptance.length > 0) {
        lines.push('完成条件：');
        acceptance.forEach((item, index) => lines.push(`  ${index + 1}. ${item}`));
    }
    lines.push('', '本轮指令：', String(instruction ?? '').trim() || '按目标继续推进。');
    lines.push('', '执行要求：动手改到目标真的达成为止；不要只给计划或说明；无法继续时明确说明缺什么。');
    return lines.join('\n');
}

/**
 * Objective evidence block. Everything here is optional and supplied by the
 * bridge; the point is that the commander judges on facts that exist outside
 * the model's own narration.
 */
export function summarizeEvidence({
    lastAssistantText = '',
    gitStatus = '',
    gitDiffStat = '',
    checks = [],
    artifacts = [],
} = {}) {
    return {
        lastAssistantText: String(lastAssistantText ?? '').trim(),
        gitStatus: String(gitStatus ?? '').trim(),
        gitDiffStat: String(gitDiffStat ?? '').trim(),
        checks: Array.isArray(checks) ? checks : [],
        artifacts: Array.isArray(artifacts) ? artifacts : [],
    };
}

/** Last assistant text in a `read_session_messages` result. */
export function lastAssistantText(messagesResult) {
    const messages = Array.isArray(messagesResult?.messages) ? messagesResult.messages : [];
    for (let i = messages.length - 1; i >= 0; i -= 1) {
        const message = messages[i];
        if (!message || message.role !== 'assistant') continue;
        const content = message.content;
        if (typeof content === 'string') {
            if (content.trim()) return content.trim();
            continue;
        }
        if (Array.isArray(content)) {
            const text = content
                .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
                .map((block) => block.text)
                .join('\n')
                .trim();
            if (text) return text;
        }
    }
    return '';
}

function truncate(text, max) {
    const value = String(text ?? '').replace(/\s+/g, ' ').trim();
    return value.length <= max ? value : `${value.slice(0, max)}…`;
}
