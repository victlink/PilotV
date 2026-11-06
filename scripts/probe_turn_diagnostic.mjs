/**
 * 诊断探针：选审查员发一轮，dump 会话区真实 DOM 与网络。
 * 只读：不改配置。会发一条真实消息。
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';

const require = createRequire('/home/Marc/PilotDeck-src/ui/package.json');
const { chromium } = require('/home/Marc/PilotDeck-src/node_modules/.pnpm/playwright@1.60.0/node_modules/playwright');
const Database = require('better-sqlite3');
const jwt = require('jsonwebtoken');

const BASE_URL = process.argv[2] || 'http://127.0.0.1:5187';
const PROJECT_ROOT = process.argv[3] || '/vol3/1000/Work/00/PilotV';
const AGENT_NAME = process.argv[4] || '审查员';
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
const wsFrames = [];
page.on('websocket', (ws) => {
    ws.on('framesent', (f) => { if (String(f.payload || '').includes('pilotdeck-command')) wsFrames.push({ dir: 'sent', payload: String(f.payload).slice(0, 8000) }); });
    ws.on('framereceived', (f) => {
        const p = String(f.payload || '');
        if (p.includes('agentName') || p.includes('agentRole')) wsFrames.push({ dir: 'recv', payload: p.slice(0, 1200) });
    });
});

try {
    await page.goto(`${BASE_URL}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(5000);
    await page.evaluate((root) => {
        const target = root.split('/').filter(Boolean).pop();
        const hit = Array.from(document.querySelectorAll('button.project-expand-button')).find((el) => (el.textContent || '').trim().startsWith(target));
        if (hit) { hit.scrollIntoView({ block: 'center' }); hit.click(); }
    }, PROJECT_ROOT);
    await page.waitForTimeout(3500);

    await page.waitForSelector('.pd-composer-agent-control button', { timeout: 20000 }).catch(() => null);
    await page.locator('.pd-composer-agent-control button').first().click();
    await page.waitForTimeout(900);
    await page.evaluate((name) => {
        const hit = Array.from(document.querySelectorAll('.pd-composer-agent-menu [role="menuitemradio"]')).find((el) => (el.textContent || '').includes(name));
        if (hit) hit.click();
    }, AGENT_NAME);
    await page.waitForTimeout(1200);
    console.log('COMPOSER LABEL:', JSON.stringify((await page.locator('.pd-composer-agent-control button').first().innerText().catch(() => '')).trim()));

    const handle = await page.evaluateHandle(() => {
        const list = Array.from(document.querySelectorAll('textarea')).filter((el) => el.offsetParent !== null);
        const inComposer = list.filter((el) => el.closest('.pd-composer-control-row'));
        return inComposer[0] || list[list.length - 1] || null;
    });
    const textarea = handle.asElement();
    await textarea.fill('【界面自检】请用一句话说明你的身份名称，不要调用任何工具。');
    await textarea.press('Enter');
    console.log('SENT at', new Date().toISOString());

    // 轮询 240s，观察会话区是否出现内容
    const deadline = Date.now() + 150000;
    let last = '';
    while (Date.now() < deadline) {
        const snapshot = await page.evaluate(() => {
            const root = document.querySelector('[data-testid="messages-pane"], .pd-messages, [class*="message"]');
            const rows = Array.from(document.querySelectorAll('[data-testid^="assistant-message"], [data-testid^="user-message"]'));
            return {
                count: rows.length,
                testids: rows.map((el) => el.getAttribute('data-testid')),
                speakers: Array.from(document.querySelectorAll('[data-testid="assistant-message-speaker"]')).map((el) => (el.textContent || '').trim()),
                text: (root ? (root.textContent || '') : (document.body.textContent || '')).slice(-600),
                allTestIds: Array.from(new Set(Array.from(document.querySelectorAll('[data-testid]')).map((el) => el.getAttribute('data-testid')))).slice(0, 60),
            };
        });
        const key = JSON.stringify({ count: snapshot.count, speakers: snapshot.speakers });
        if (key !== last) {
            last = key;
            console.log(`[${new Date().toISOString()}] rows=${snapshot.count} testids=${JSON.stringify(snapshot.testids)} speakers=${JSON.stringify(snapshot.speakers)}`);
            console.log('   tail:', JSON.stringify(snapshot.text.slice(-260)));
            console.log('   testids:', JSON.stringify(snapshot.allTestIds));
        }
        if (snapshot.speakers.length > 0) break;
        await page.waitForTimeout(3000);
    }
    await page.screenshot({ path: `${OUT_DIR}/diagnostic-turn.png`, fullPage: false });
    console.log('WS FRAMES:');
    for (const f of wsFrames.slice(0, 12)) console.log(' ', f.dir, f.payload.slice(0, 8000));
} finally {
    await browser.close();
}
