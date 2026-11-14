/**
 * 单 turn「无进展」熔断（stall guard）。
 *
 * 为什么需要
 * ----------
 * 2026-11-14 的咖啡机事故里，一个 turn 跑了 229 轮、5 小时 14 分、约 1900 万
 * token，最后被 `aborted_streaming` 中止，任务却没完成。过程有两种典型空转：
 *
 *   1. 子 agent 被「记忆说只读、别跑 FreeCAD」和「当前指令要求写文件并跑
 *      FreeCAD」的冲突卡住，1 小时内反复输出同一段思考直到超时；
 *   2. 主 agent 反复用 edit_file 改同一处，每次都拿到
 *      `TOOL_ERROR[invalid_tool_input][edit_file]`，同一段 thinking 复读 20 次。
 *
 * 已有的 commander loop 护栏只作用在「轮次」层（6 轮 / 45 分钟 / 重复指令 /
 * 无效判定），对**单个 turn 内部**的空转完全看不见；上游 AgentLoop.ts 里的
 * circuit breaker 又要求「本轮所有工具调用都失败且 fingerprint 完全一致」，
 * 只要中间夹一次成功的 read_file 就清零，所以也没拦住。
 *
 * 这里在 bridge 的事件流上做检测：重复 thinking 前缀、重复工具失败、无进展
 * 静默、单 turn 绝对时长与 token。命中后由 `runChatViaGateway` 主动 abort，
 * 并把 `turnFinishReason` 标成 `stalled_no_progress`。
 *
 * 进展感知（2026-11-14 二次修正）
 * ------------------------------
 * 初版把 `maxTurnWallClockMs` 当成绝对 45 分钟上限，结果把两个**正在正常推进**
 * 的长 CAD turn 砍了：一个 72 turns / 91 次工具调用、最后在 `task_wait` 等子
 * agent；另一个 54 turns / 96 次工具调用、thinking 里还列着待办。二者都被
 * abort 并归档 `waiting_user`，界面上表现为「又停止了，没完成」。
 *
 * 根因是「时长」不等于「无进展」：CAD 构建、`task_wait`、FreeCAD Python 都
 * 可能让单个工具跑十几分钟。现在改为：
 *   - 记录最后一次有效进展（任意成功完成的工具 / 子 agent 工具结果 / 文件产物）；
 *   - 只有**没有工具在执行**且静默超过 `maxIdleMs` 才判 `turn_idle`；
 *     工具在飞（`tool_call_started` 未 `finished`）期间不计时，属正常等待；
 *   - `maxTurnWallClockMs` 退为 4 小时的绝对兜底，防线不再是 45 分钟；
 *   - 重复 thinking / 重复工具失败仍按原逻辑抓真正的死循环。
 * 这样「1 小时只复读同一段 thinking、没有任何工具产出」仍会被抓，而
 * 「持续有成功工具但跑了 1 小时」不会被误杀。
 *
 * 关键语义：这是**终态，不是崩溃**。上层 commander loop 必须把它归档为
 * `waiting_user`，绝不能标 `interrupted` —— 否则恢复守护 20 秒后自动续跑，
 * 会立刻重新卡进同一个循环，形成「崩溃 → 自动恢复 → 再卡死」的死循环。
 *
 * 纯逻辑，不碰 fs / 网络 / 时钟之外的东西，方便直接单测。
 */

export const STALL_FINISH_REASON = 'stalled_no_progress';
/** commander 账本归档时用的 stopReason，恢复守护见到它就永不续跑。 */
export const NO_PROGRESS_STOP_REASON = 'no_progress_stall';

export function isStallFinishReason(reason) {
    return typeof reason === 'string' && reason.startsWith('stalled_');
}

export function isNoProgressStopReason(reason) {
    return reason === NO_PROGRESS_STOP_REASON;
}

export const TURN_STALL_DEFAULTS = Object.freeze({
    enabled: true,
    /** 连续多少轮相同 thinking 前缀算空转。5 次避免把「重述待办」误判为死循环。 */
    maxRepeatedThinking: 5,
    /** 连续多少次相同工具失败算空转。 */
    maxRepeatedToolFailure: 4,
    /** 没有任何有效进展的最长静默时间；工具执行中不计时。 */
    maxIdleMs: 30 * 60_000,
    /** 单个 turn 绝对兜底墙钟（有进展也停，防长任务彻底失控）。 */
    maxTurnWallClockMs: 4 * 60 * 60_000,
    /** 单个 turn 累计 token 上限（含 cache read）。 */
    maxTurnTokens: 8_000_000,
    /** thinking 指纹取前多少字符。 */
    thinkingKeyChars: 120,
});

/**
 * 明确会改变工作区的工具。只有这类工具**成功**才重置 thinking 计数；
 * read_file 之类只读工具成功不代表有进展——事故里正是「读成功、写失败」
 * 反复出现，若把读也算进展就永远抓不到。
 */
const PROGRESS_TOOL_NAMES = new Set([
    'edit_file', 'write_file', 'create_file', 'save_file', 'write_to_file',
    'replace_in_file', 'multi_edit', 'apply_patch', 'patch', 'str_replace_editor',
    'delete_file', 'move_file', 'rename_file', 'copy_file', 'mkdir',
    'bash', 'shell', 'exec', 'terminal', 'run_command', 'execute_command',
    'run_python', 'run_freecad',
]);

export function isProgressTool(name) {
    const normalized = String(name ?? '').toLowerCase().replace(/[\s-]+/g, '_');
    if (!normalized) return false;
    if (PROGRESS_TOOL_NAMES.has(normalized)) return true;
    // 兼容 `functions.edit_file` / `tools.write_file` 之类的带前缀名字。
    return [...PROGRESS_TOOL_NAMES].some((tool) => normalized.endsWith(`.${tool}`));
}

/** 折叠空白、统一大小写、只取前 N 字符；空文本返回空串（不参与计数）。 */
export function thinkingFingerprint(text, chars = TURN_STALL_DEFAULTS.thinkingKeyChars) {
    const normalized = String(text ?? '').replace(/\s+/g, ' ').trim();
    if (!normalized) return '';
    return normalized.slice(0, Math.max(1, chars)).toLowerCase();
}

/**
 * 工具失败指纹。去掉引号里的具体内容和数字，否则 old_string / 行号每次略
 * 有不同就会让 fingerprint 变化，现有 circuit breaker 正是栽在这里。
 */
export function toolFailureFingerprint({ toolName, errorCode, message } = {}) {
    const name = String(toolName ?? '').toLowerCase().trim() || 'unknown';
    const code = String(errorCode ?? '').toLowerCase().trim() || 'unknown';
    const cleaned = String(message ?? '')
        .replace(/TOOL_ERROR\[[^\]]*\]/g, 'TOOL_ERROR')
        .replace(/"[^"]*"/g, '"…"')
        .replace(/'[^']*'/g, "'…'")
        .replace(/\b\d+\b/g, '#')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 100)
        .toLowerCase();
    return `${name}|${code}|${cleaned}`;
}

function limitFromEnv(env, name, fallback) {
    const raw = String(env[name] ?? '').trim();
    if (raw === '') return fallback;
    const value = Number.parseInt(raw, 10);
    if (!Number.isFinite(value)) return fallback;
    // 显式 0 = 关闭这一项检测。
    if (value === 0) return Number.POSITIVE_INFINITY;
    return value > 0 ? value : fallback;
}

/**
 * 阈值全部可用环境变量覆盖，方便长任务临时放宽，不用改代码。
 *   PILOTV_STALL_ENABLED=0                      总开关
 *   PILOTV_STALL_MAX_REPEATED_THINKING=0       关掉重复思考检测
 *   PILOTV_STALL_MAX_REPEATED_TOOL_FAILURE=0   关掉重复失败检测
 *   PILOTV_STALL_MAX_IDLE_MS=0                 关掉无进展静默检测
 *   PILOTV_STALL_MAX_TURN_MS=0                 关掉绝对时长兜底
 *   PILOTV_STALL_MAX_TURN_TOKENS=0             关掉 token 上限
 */
export function readTurnStallConfig(env = process.env) {
    const rawEnabled = String(env.PILOTV_STALL_ENABLED ?? '').trim().toLowerCase();
    const enabled = rawEnabled === ''
        ? TURN_STALL_DEFAULTS.enabled
        : !['0', 'false', 'no', 'off', 'disabled'].includes(rawEnabled);
    return {
        enabled,
        maxRepeatedThinking: limitFromEnv(env, 'PILOTV_STALL_MAX_REPEATED_THINKING', TURN_STALL_DEFAULTS.maxRepeatedThinking),
        maxRepeatedToolFailure: limitFromEnv(env, 'PILOTV_STALL_MAX_REPEATED_TOOL_FAILURE', TURN_STALL_DEFAULTS.maxRepeatedToolFailure),
        maxIdleMs: limitFromEnv(env, 'PILOTV_STALL_MAX_IDLE_MS', TURN_STALL_DEFAULTS.maxIdleMs),
        maxTurnWallClockMs: limitFromEnv(env, 'PILOTV_STALL_MAX_TURN_MS', TURN_STALL_DEFAULTS.maxTurnWallClockMs),
        maxTurnTokens: limitFromEnv(env, 'PILOTV_STALL_MAX_TURN_TOKENS', TURN_STALL_DEFAULTS.maxTurnTokens),
        thinkingKeyChars: TURN_STALL_DEFAULTS.thinkingKeyChars,
    };
}

/**
 * @param {object} options
 * @param {object} [options.config] readTurnStallConfig() 的结果
 * @param {() => number} [options.now] 注入时钟便于测试
 * @returns {{observe: (event: object) => object|null, snapshot: () => object, stalled: object|null}}
 */
export function createTurnStallGuard(input = {}) {
    // 传了 config 就完全用传入值（测试不受进程环境变量干扰）；没传才读环境。
    const config = { ...TURN_STALL_DEFAULTS, ...(input.config ?? readTurnStallConfig()) };
    const now = input.now ?? (() => Date.now());
    const startedAtMs = now();
    let stalled = null;
    /** 最后一次观察到有效进展的时刻；工具执行中不计时。 */
    let lastProgressAtMs = startedAtMs;
    /** 已开始但尚未结束的工具调用数。 */
    let inFlightTools = 0;
    let observedContextUsed = 0;
    let thinkingBuffer = '';
    let subagentThinkingBuffer = '';
    let lastThinkingKey = '';
    let repeatedThinking = 0;
    let lastSubagentThinkingKey = '';
    let repeatedSubagentThinking = 0;
    let lastFailureKey = '';
    let repeatedFailure = 0;
    let totalTokens = 0;
    let turnCompleted = false;

    const markProgress = () => { lastProgressAtMs = now(); };

    const trip = (code, detail) => {
        if (stalled) return stalled;
        stalled = {
            code,
            detail,
            at: new Date(now()).toISOString(),
            elapsedMs: Math.max(0, now() - startedAtMs),
            totalTokens,
        };
        return stalled;
    };

    const settleThinking = (raw, source) => {
        const key = thinkingFingerprint(raw, config.thinkingKeyChars);
        if (!key) return null;
        if (source === 'subagent') {
            if (key === lastSubagentThinkingKey) repeatedSubagentThinking += 1;
            else { repeatedSubagentThinking = 1; lastSubagentThinkingKey = key; }
            if (repeatedSubagentThinking >= config.maxRepeatedThinking) {
                return trip('repeated_subagent_thinking', {
                    repeated: repeatedSubagentThinking,
                    sample: key.slice(0, 80),
                });
            }
            return null;
        }
        if (key === lastThinkingKey) repeatedThinking += 1;
        else { repeatedThinking = 1; lastThinkingKey = key; }
        if (repeatedThinking >= config.maxRepeatedThinking) {
            return trip('repeated_thinking', { repeated: repeatedThinking, sample: key.slice(0, 80) });
        }
        return null;
    };

    const observe = (event) => {
        if (!config.enabled || stalled) return stalled;
        if (!event || typeof event !== 'object') return null;

        const currentMs = now();
        const elapsedMs = currentMs - startedAtMs;
        // 绝对兜底：无论有没有进展，单个 turn 都不允许无限跑。
        if (elapsedMs >= config.maxTurnWallClockMs) {
            return trip('turn_timeout', { elapsedMs, limitMs: config.maxTurnWallClockMs });
        }
        // 无进展静默才是主要停手条件。工具在飞时属于正常等待（FreeCAD 构建、
        // task_wait 等子 agent），不能因为跑得久就误杀。
        const idleMs = currentMs - lastProgressAtMs;
        if (inFlightTools === 0 && idleMs >= config.maxIdleMs) {
            return trip('turn_idle', { idleMs, limitMs: config.maxIdleMs, elapsedMs });
        }

        switch (event.type) {
            case 'assistant_thinking_delta': {
                if (thinkingBuffer.length < config.thinkingKeyChars * 2) {
                    thinkingBuffer += String(event.text ?? '');
                }
                return null;
            }
            case 'assistant_block': {
                if (event.kind && event.kind !== 'thinking') return null;
                const text = String(event.text ?? '') || thinkingBuffer;
                thinkingBuffer = '';
                return settleThinking(text, 'main');
            }
            case 'assistant_stream_end': {
                if (!thinkingBuffer) return null;
                const text = thinkingBuffer;
                thinkingBuffer = '';
                return settleThinking(text, 'main');
            }
            case 'subagent_thinking_delta': {
                if (subagentThinkingBuffer.length < config.thinkingKeyChars * 2) {
                    subagentThinkingBuffer += String(event.text ?? event.content ?? '');
                }
                return null;
            }
            case 'subagent_assistant_block': {
                if (event.kind && event.kind !== 'thinking') return null;
                const text = String(event.text ?? event.content ?? '') || subagentThinkingBuffer;
                subagentThinkingBuffer = '';
                return settleThinking(text, 'subagent');
            }
            case 'subagent_stream_end': {
                if (!subagentThinkingBuffer) return null;
                const text = subagentThinkingBuffer;
                subagentThinkingBuffer = '';
                return settleThinking(text, 'subagent');
            }
            case 'tool_call_started': {
                inFlightTools += 1;
                return null;
            }
            case 'subagent_tool_result':
            case 'file_artifacts': {
                // 子 agent 有产出、或本轮生成了文件产物，都算有效进展。
                markProgress();
                return null;
            }
            case 'tool_call_finished': {
                inFlightTools = Math.max(0, inFlightTools - 1);
                if (event.ok === false) {
                    const key = toolFailureFingerprint({
                        toolName: event.toolName ?? event.name,
                        errorCode: event.errorCode,
                        message: event.resultPreview ?? event.message,
                    });
                    if (key === lastFailureKey) repeatedFailure += 1;
                    else { repeatedFailure = 1; lastFailureKey = key; }
                    if (repeatedFailure >= config.maxRepeatedToolFailure) {
                        return trip('repeated_tool_failure', { repeated: repeatedFailure, fingerprint: key });
                    }
                    return null;
                }
                if (event.ok === true) {
                    // 任意成功完成的工具都重置静默计时：它证明 agent 还在往前走。
                    markProgress();
                    repeatedFailure = 0;
                    lastFailureKey = '';
                    // 但只有真正改动工作区的成功工具才清空「复读」计数，
                    // 「读成功、写失败」的死循环才不会被 read_file 洗白。
                    if (isProgressTool(event.toolName ?? event.name)) {
                        repeatedThinking = 0;
                        lastThinkingKey = '';
                        repeatedSubagentThinking = 0;
                        lastSubagentThinkingKey = '';
                    }
                }
                return null;
            }
            case 'context_budget': {
                // 只记录上下文用量便于排查，不据此熔断：`used` 是「当前上下文
                // 占用」而非累计消耗，压缩后还会回落，拿来当上限会误报。
                const used = Number(event.used ?? event.displayUsed ?? 0);
                if (Number.isFinite(used)) observedContextUsed = Math.max(observedContextUsed, used);
                return null;
            }
            case 'turn_completed': {
                turnCompleted = true;
                const tokens = Number(event.usage?.totalTokens ?? 0);
                if (Number.isFinite(tokens)) totalTokens = Math.max(totalTokens, tokens);
                if (totalTokens >= config.maxTurnTokens) {
                    return trip('turn_token_budget', { totalTokens, limit: config.maxTurnTokens });
                }
                return null;
            }
            default:
                return null;
        }
    };

    return {
        observe,
        get stalled() { return stalled; },
        snapshot() {
            return {
                enabled: config.enabled,
                startedAtMs,
                elapsedMs: now() - startedAtMs,
                repeatedThinking,
                repeatedSubagentThinking,
                repeatedFailure,
                totalTokens,
                observedContextUsed,
                inFlightTools,
                lastProgressAtMs,
                idleMs: now() - lastProgressAtMs,
                turnCompleted,
                stalled,
                config: { ...config },
            };
        },
    };
}
