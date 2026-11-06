/**
 * 线上验收探针：项目 Agent turn 矩阵。
 *
 * 用途：
 *   1) agent 模式 —— 传入稳定 agentId，验证 role briefing / 身份贯穿 / participants 通道；
 *   2) plain 模式 —— 不传 agentId，验证默认 Agent 普通会话无回归。
 *
 * 与早期探针（accept_agent_turn_v4.mjs）的差别：
 *   早期探针只在收到 kind==='message' && role==='assistant' 时判定完成，
 *   但线上实际推送的助手帧是 kind==='text' && role==='assistant'，
 *   导致实际已成功产出助手回复却误报 timeout。本探针按 role 判定，并额外
 *   打印 kind/type 分布，便于区分「真实卡住」与「判定口径不匹配」。
 *
 * 用法：
 *   node scripts/verify_project_team_turn_matrix.mjs [mode] [timeoutMs] [projectRoot]
 *     mode: agent | plain   （默认 agent）
 *
 * 该脚本会临时写入 <projectRoot>/.pilotdeck/project-team.json，结束时原样还原；
 * 若原本不存在则删除。不触碰其他项目。
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire('/home/Marc/PilotDeck-src/ui/package.json');
const WebSocket = require('ws');
const Database = require('better-sqlite3');

const MODE = (process.argv[2] || 'agent').toLowerCase();
const TIMEOUT_MS = Number(process.argv[3] || 180000);
const PROJECT_ROOT = process.argv[4] || '/home/Marc/pilotv-accept-20261104';

if (!['agent', 'plain'].includes(MODE)) {
    console.error(`未知 mode: ${MODE}（可选 agent | plain）`);
    process.exit(2);
}

const db = new Database('/home/Marc/.pilotdeck/auth.db', { readonly: true });
const row = db.prepare('select value from app_config where key = ?').get('jwt_secret');
db.close();
const token = require('jsonwebtoken').sign({ userId: 1, username: 'Marc' }, row.value, { expiresIn: '2h' });

const WS_BASE = 'ws://127.0.0.1:3001';
const HTTP_BASE = 'http://127.0.0.1:3001';
const CONFIG_PATH = path.join(PROJECT_ROOT, '.pilotdeck', 'project-team.json');
const hadOriginal = fs.existsSync(CONFIG_PATH);
const originalRaw = hadOriginal ? fs.readFileSync(CONFIG_PATH, 'utf8') : null;

const AGENT_ID = 'agent-accept-matrix';
const PROMPT = MODE === 'agent'
    ? '请只回答一句话：你的身份名称是什么？不要调用任何工具。'
    : '请只回答一句话：收到。不要调用任何工具。';

function writeProbeConfig() {
    if (MODE === 'plain') return; // plain 模式不需要 team 配置
    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
    const base = hadOriginal ? JSON.parse(originalRaw) : { version: 1, revision: '0'.repeat(32) };
    fs.writeFileSync(CONFIG_PATH, JSON.stringify({
        ...base,
        version: 1,
        revision: typeof base.revision === 'string' ? base.revision : '0'.repeat(32),
        collaboration: { mode: 'manual' },
        agents: [{
            id: AGENT_ID,
            name: '验收矩阵探针',
            description: '端到端验收用，只允许只读工具。',
            role: 'reviewer',
            roleDefinition: '只允许读取文件，禁止执行命令与写入。',
            model: null,
            enabled: true,
            permissions: {
                toolAccess: 'allow-list',
                allowedTools: ['read_file', 'grep', 'glob'],
                deniedTools: [],
                network: 'none',
                writeScope: 'read-only',
                requireApproval: true,
            },
            reportsTo: null,
        }],
    }, null, 2));
}

function summarize(frame) {
    return {
        kind: frame.kind ?? null,
        type: frame.type ?? null,
        role: frame.role ?? null,
        status: frame.status ?? null,
        text: typeof frame.text === 'string' ? frame.text.slice(0, 100) : frame.text ?? null,
        agentName: frame.agentName ?? null,
        agentRole: frame.agentRole ?? null,
        contentHead: typeof frame.content === 'string' ? frame.content.slice(0, 140) : undefined,
    };
}

async function runTurn() {
    const ws = new WebSocket(`${WS_BASE}/ws?token=${encodeURIComponent(token)}`);
    const frames = [];
    let myKey = null;

    const finished = new Promise((resolve) => {
        const timer = setTimeout(() => resolve('timeout'), TIMEOUT_MS);
        ws.on('message', (raw) => {
            let frame;
            try { frame = JSON.parse(raw.toString()); } catch { return; }
            frames.push(frame);
            if (frame.kind === 'session_created' && frame.sessionId) myKey = frame.sessionId;
            // 判定口径：线上助手帧为 kind==='text' && role==='assistant'；
            // 同时兼容 kind==='message'，并把显式失败视为已结束。
            if (frame.kind === 'error' || frame.kind === 'turn_failed'
                || (frame.role === 'assistant' && (frame.kind === 'text' || frame.kind === 'message'))
                || (frame.kind === 'status' && ['failed', 'error'].includes(frame.status))) {
                clearTimeout(timer);
                resolve('settled');
            }
        });
        ws.on('error', (e) => { clearTimeout(timer); resolve(`ws_error:${e.message}`); });
        ws.on('close', (code) => resolve(`ws_close:${code}`));
    });

    await new Promise((r) => ws.on('open', r));
    const t0 = Date.now();

    const options = {
        projectPath: PROJECT_ROOT,
        cwd: PROJECT_ROOT,
        workspaceCwd: PROJECT_ROOT,
        userVisibleInput: PROMPT,
    };
    if (MODE === 'agent') options.agentId = AGENT_ID;

    ws.send(JSON.stringify({ type: 'pilotdeck-command', command: PROMPT, options }));

    const outcome = await finished;
    const elapsed = Date.now() - t0;

    let restMessages = null;
    let restError = null;
    if (myKey) {
        try {
            const url = `${HTTP_BASE}/api/sessions/${encodeURIComponent(myKey)}/messages`
                + `?projectPath=${encodeURIComponent(PROJECT_ROOT)}&limit=50`;
            const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
            const body = await res.json();
            restMessages = body?.messages ?? body?.data?.messages ?? body;
            if (!Array.isArray(restMessages)) restMessages = Array.isArray(body?.data) ? body.data : [];
        } catch (e) {
            restError = e?.message || String(e);
        }
    }

    try { ws.close(); } catch { /* ignore */ }

    const mine = frames.filter((f) => !f.sessionId || f.sessionId === myKey);
    const assistantFrames = mine.filter((f) => f.role === 'assistant');
    const participantFrames = mine.filter((f) => f.type === 'project-participants' || f.kind === 'project-participants');
    const kindCounts = {};
    for (const f of mine) {
        const k = f.kind ?? f.type ?? '(none)';
        kindCounts[k] = (kindCounts[k] || 0) + 1;
    }

    console.log(`mode=${MODE} outcome=${outcome} elapsedMs=${elapsed} sessionId=${myKey} project=${PROJECT_ROOT}`);
    console.log(`mine=${mine.length} assistant=${assistantFrames.length} assistantWithAgent=${assistantFrames.filter(f => f.agentName || f.agentRole).length} participants=${participantFrames.length}`);
    console.log('kindCounts =', JSON.stringify(kindCounts));
    console.log('-- participants --');
    for (const f of participantFrames) console.log('   ', JSON.stringify({ type: f.type, kind: f.kind, participants: f.participants }));
    console.log('-- assistant frames --');
    for (const f of assistantFrames) console.log('   ', JSON.stringify(summarize(f)));
    console.log('-- REST persisted --');
    console.log('   restError =', restError);
    if (Array.isArray(restMessages)) {
        console.log('   messageCount =', restMessages.length);
        for (const m of restMessages.slice(-8)) {
            console.log('   ', JSON.stringify({
                role: m.role ?? m.message?.role ?? null,
                agentName: m.agentName ?? m.message?.agentName ?? null,
                agentRole: m.agentRole ?? m.message?.agentRole ?? null,
                head: (m.content ?? m.text ?? '').slice?.(0, 160),
            }));
        }
    }

    const errors = mine.filter((f) => f.kind === 'error' || f.kind === 'turn_failed');
    return {
        mode: MODE,
        outcome,
        elapsed,
        sessionId: myKey,
        assistant: assistantFrames.length,
        assistantWithAgent: assistantFrames.filter((f) => f.agentName || f.agentRole).length,
        participants: participantFrames.length,
        restCount: Array.isArray(restMessages) ? restMessages.length : -1,
        errors: errors.length,
        participantPayload: participantFrames[0]?.participants ?? null,
    };
}

let result = null;
try {
    writeProbeConfig();
    console.log(`[probe] mode=${MODE} 配置=${MODE === 'agent' ? AGENT_ID : '(不需要)'} @ ${PROJECT_ROOT}`);
    result = await runTurn();
} catch (e) {
    console.log('[probe] ERROR', e?.stack || e?.message || String(e));
} finally {
    if (hadOriginal) {
        fs.writeFileSync(CONFIG_PATH, originalRaw);
        console.log('\n[restored] 原配置已写回');
    } else {
        try { fs.rmSync(CONFIG_PATH, { force: true }); } catch { /* ignore */ }
        console.log('\n[restored] 探针配置已删除');
    }
}
console.log('\n===== RESULT =====');
console.log(JSON.stringify(result));
process.exit(0);
