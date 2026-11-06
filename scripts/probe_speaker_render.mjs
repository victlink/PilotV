/**
 * 只读探针：打开一条已经带 agentName 的历史会话，验证
 *  1) 消息里是否渲染出成员名字 + 独立颜色；
 *  2) 条带是否列该成员并可点选筛选；
 *  3) 筛选后只剩该成员，点「团队」恢复。
 *
 * 不发消息、不改配置。
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
const SPEAKER = process.argv[5] || '验收矩阵探针';
const OUT_DIR = '/vol4/1000/00/产物/PilotV_1.0.0_20261106/probe';

const results = [];
const check = (name, ok, detail) => {
    results.push({ name, ok, detail });
    console.log(`${ok ? 'PASS' : 'FAIL'} | ${name}${detail ? ' | ' + detail : ''}`);
};

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

try {
    await page.goto(`${BASE_URL}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(5000);

    // 打开目标项目
    await page.evaluate((label) => {
        const hit = Array.from(document.querySelectorAll('button.project-expand-button'))
            .find((el) => (el.textContent || '').trim().startsWith(label));
        if (hit) { hit.scrollIntoView({ block: 'center' }); hit.click(); }
    }, PROJECT_LABEL);
    await page.waitForTimeout(3000);

    // 找到含提示词的历史会话并打开
    const opened = await page.evaluate((hint) => {
        const nodes = Array.from(document.querySelectorAll('button, [role="button"], a, li, div'));
        const hit = nodes.find((el) => {
            const t = (el.textContent || '').trim();
            return t.includes(hint) && t.length < 400 && el.getBoundingClientRect().height > 0;
        });
        if (!hit) return false;
        hit.scrollIntoView({ block: 'center' });
        hit.click();
        return true;
    }, SESSION_HINT);
    check('打开目标会话', opened, `hint=${SESSION_HINT}`);
    await page.waitForTimeout(6000);

    const speakerSelector = '[data-testid="assistant-message-speaker"]';
    await page.waitForSelector(speakerSelector, { timeout: 30000 }).catch(() => null);

    const info = await page.evaluate((sel) => {
        const buttons = Array.from(document.querySelectorAll(sel));
        return {
            total: buttons.length,
            items: buttons.map((el) => ({
                text: (el.textContent || '').trim(),
                className: el.getAttribute('class'),
                title: el.getAttribute('title'),
            })),
        };
    }, speakerSelector);
    check('会话里渲染出成员名字', info.items.some((i) => i.text === SPEAKER), `speakers=${JSON.stringify(info.items.map((i) => i.text))}`);
    const target = info.items.find((i) => i.text === SPEAKER);
    const colorMatch = (target?.className || '').match(/text-(violet|purple|fuchsia|amber|orange|yellow|blue|sky|indigo|emerald|teal|green|rose|cyan|lime)-\d+/);
    check('成员发言使用独立颜色', Boolean(colorMatch), `class=${target?.className || 'none'} color=${colorMatch ? colorMatch[0] : 'none'}`);

    const chips = await page.evaluate(() => Array.from(document.querySelectorAll('[data-testid="speaker-filter-item"]')).map((el) => ({
        key: el.getAttribute('data-speaker-key'),
        label: (el.textContent || '').trim(),
        ariaLabel: el.getAttribute('aria-label'),
        pressed: el.getAttribute('aria-pressed'),
    })));
    check('条带列出发言人', chips.length > 0, `chips=${JSON.stringify(chips)}`);

    const chip = page.locator(`[data-speaker-key="name:${SPEAKER}"]`);
    if (await chip.count()) {
        await chip.first().click();
        await page.waitForTimeout(800);
        const after = await page.evaluate((sel) => Array.from(document.querySelectorAll(sel)).map((el) => (el.textContent || '').trim()), speakerSelector);
        check('筛选后只剩该成员发言', after.length > 0 && after.every((t) => t === SPEAKER), `after=${JSON.stringify(after)}`);
        check('筛选项进入选中态', (await chip.first().getAttribute('aria-pressed')) === 'true', '');
        await page.screenshot({ path: `${OUT_DIR}/render-filter-active.png` });
        await page.locator('[data-testid="speaker-filter-team"]').click();
        await page.waitForTimeout(800);
        const restored = await page.evaluate((sel) => Array.from(document.querySelectorAll(sel)).map((el) => (el.textContent || '').trim()), speakerSelector);
        check('点「团队」恢复全部', restored.length >= after.length, `restored=${JSON.stringify(restored)}`);
    } else {
        check('条带含该成员筛选项', false, `key=name:${SPEAKER}`);
    }
    await page.screenshot({ path: `${OUT_DIR}/render-strip.png` });
} finally {
    await browser.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\nSUMMARY: ${results.length - failed.length}/${results.length} passed`);
if (failed.length) { console.log('FAILED:', JSON.stringify(failed, null, 2)); process.exit(1); }
