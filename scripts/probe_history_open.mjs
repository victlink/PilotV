/**
 * 只读诊断：打开历史会话，抓 sessions messages 接口响应与实际 DOM。
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';

const require = createRequire('/home/Marc/PilotDeck-src/ui/package.json');
const { chromium } = require('/home/Marc/PilotDeck-src/node_modules/.pnpm/playwright@1.60.0/node_modules/playwright');
const Database = require('better-sqlite3');
const jwt = require('jsonwebtoken');

const BASE_URL = process.argv[2] || 'http://127.0.0.1:5187';
const PROJECT_LABEL = process.argv[3] || 'pilotv-accept-20261104';
const SESSION_HINT = process.argv[4] || '请只回答一句话';
const OUT_DIR = '/vol4/1000/00/产物/PilotV_1.0.0_20261106/probe';

const db = new Database('/home/Marc/.pilotdeck/auth.db', { readonly: true });
const row = db.prepare('select value from app_config where key = ?').get('jwt_secret');
db.close();
const token = jwt.sign({ userId: 1, username: 'Marc' }, row.value, { expiresIn: '2h' });
const ORIGINS = [BASE_URL, 'http://127.0.0.1:3001', 'http://127.0.0.1:5187', 'http://localhost:3001'];

fs.mkdirSync(OUT_DIR, { recursive: true });
const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await context.addInitScript(({ token, origins }) => {
    const map = {};
    for (const o of origins) map[o] = token;
    try { localStorage.setItem('pilotdeck-tokens', JSON.stringify(map)); } catch {}
    try { localStorage.setItem('auth-token', token); } catch {}
}, { token, origins: ORIGINS });
const page = await context.newPage();

const msgCalls = [];
page.on('response', async (r) => {
    if (!r.url().includes('/messages')) return;
    const rec = { status: r.status(), url: r.url().replace(/^https?:\/\/[^/]+/, '') };
    try {
        const j = await r.json();
        const msgs = Array.isArray(j?.messages) ? j.messages : (Array.isArray(j?.data?.messages) ? j.data.messages : (Array.isArray(j) ? j : []));
        rec.count = msgs.length;
        rec.sample = msgs.slice(-6).map((m) => ({
            role: m.role ?? m.message?.role ?? null,
            agentName: m.agentName ?? m.message?.agentName ?? null,
            agentRole: m.agentRole ?? m.message?.agentRole ?? null,
            head: String(m.content ?? m.text ?? '').slice(0, 60),
        }));
    } catch (e) { rec.error = String(e).slice(0, 120); }
    msgCalls.push(rec);
});

try {
    await page.goto(`${BASE_URL}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(5000);
    await page.evaluate((label) => {
        const hit = Array.from(document.querySelectorAll('button.project-expand-button')).find((el) => (el.textContent || '').trim().startsWith(label));
        if (hit) { hit.scrollIntoView({ block: 'center' }); hit.click(); }
    }, PROJECT_LABEL);
    await page.waitForTimeout(3000);

    const clicked = await page.evaluate((hint) => {
        const more = Array.from(document.querySelectorAll('button, span, a')).find((el) => (el.textContent || '').trim().startsWith('Show more'));
        if (more) more.click();
        const nodes = Array.from(document.querySelectorAll('button, [role="button"], a, li, div, span, p'));
        const cands = nodes.filter((el) => {
            const t = (el.textContent || '').trim();
            return t.includes(hint) && el.getBoundingClientRect().height > 0 && el.getBoundingClientRect().width > 0;
        });
        if (!cands.length) return { ok: false };
        const hit = cands.reduce((best, el) => (el.querySelectorAll('*').length < best.querySelectorAll('*').length ? el : best));
        hit.scrollIntoView({ block: 'center' });
        hit.click();
        return { ok: true, tag: hit.tagName, cls: String(hit.className).slice(0, 120), text: (hit.textContent || '').trim().slice(0, 120), depth: hit.querySelectorAll('*').length };
    }, SESSION_HINT);
    console.log('CLICK:', JSON.stringify(clicked));
    await page.waitForTimeout(8000);

    const dom = await page.evaluate(() => {
        const main = document.querySelector('main') || document.body;
        return {
            url: location.href,
            testids: Array.from(new Set(Array.from(document.querySelectorAll('[data-testid]')).map((el) => el.getAttribute('data-testid')))).slice(0, 80),
            speakers: Array.from(document.querySelectorAll('[data-testid="assistant-message-speaker"]')).map((el) => (el.textContent || '').trim()),
            mainText: (main.textContent || '').slice(0, 1200),
        };
    });
    console.log('URL:', dom.url);
    console.log('TESTIDS:', JSON.stringify(dom.testids));
    console.log('SPEAKERS:', JSON.stringify(dom.speakers));
    console.log('MAIN TEXT:', JSON.stringify(dom.mainText.slice(0, 900)));
    console.log('MESSAGE CALLS:');
    for (const c of msgCalls) console.log(' ', JSON.stringify(c).slice(0, 900));
    await page.screenshot({ path: `${OUT_DIR}/history-open.png` });
} finally {
    await browser.close();
}
