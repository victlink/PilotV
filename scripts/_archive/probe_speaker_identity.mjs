/**
 * 线上验收探针：多 Agent 发言人身份（颜色 / 名字 / 筛选）。
 *
 * 覆盖：
 *  1) composer 里选中项目团队成员（审查员），发一轮真实消息；
 *  2) 这条回复是否带上独立发言人名字 + 与默认 Agent 不同的颜色；
 *  3) 会话上方条带是否按角色列出发言人，并可点选筛选；
 *  4) 筛选后只剩该发言人的发言，点「团队」恢复全部。
 *
 * 只读：不改项目配置、不改团队文件。会在 PilotV 项目下产生一条真实会话消息。
 *
 * 用法：node scripts/_archive/probe_speaker_identity.mjs [baseUrl] [projectRoot] [agentName]
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
await context.addInitScript(
    ({ token, origins }) => {
        const map = {};
        for (const o of origins) map[o] = token;
        try { localStorage.setItem('pilotdeck-tokens', JSON.stringify(map)); } catch {}
        try { localStorage.setItem('auth-token', token); } catch {}
    },
    { token, origins: ORIGINS },
);
const page = await context.newPage();
const consoleErrors = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 200)); });

try {
    await page.goto(`${BASE_URL}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(5000);

    // 选中项目
    const clicked = await page.evaluate((root) => {
        const target = root.split('/').filter(Boolean).pop();
        const buttons = Array.from(document.querySelectorAll('button.project-expand-button'));
        const hit = buttons.find((el) => (el.textContent || '').trim().startsWith(target));
        if (!hit) return false;
        hit.scrollIntoView({ block: 'center' });
        hit.click();
        return true;
    }, PROJECT_ROOT);
    check('侧栏可点击项目节点', clicked, `project=${PROJECT_ROOT}`);
    await page.waitForTimeout(3500);

    // ---- 1. composer 选中团队成员 ----
    await page.waitForSelector('.pd-composer-agent-control button', { timeout: 20000 }).catch(() => null);
    await page.locator('.pd-composer-agent-control button').first().click();
    await page.waitForTimeout(900);
    const optionClicked = await page.evaluate((name) => {
        const items = Array.from(document.querySelectorAll('.pd-composer-agent-menu [role="menuitemradio"]'));
        const hit = items.find((el) => (el.textContent || '').includes(name));
        if (!hit) return { ok: false, items: items.map((el) => (el.textContent || '').trim()) };
        hit.click();
        return { ok: true, items: items.map((el) => (el.textContent || '').trim()) };
    }, AGENT_NAME);
    check('composer 可选中团队成员', optionClicked.ok, `menu=${JSON.stringify(optionClicked.items)}`);
    await page.waitForTimeout(1200);
    const selectedLabel = await page.locator('.pd-composer-agent-control button').first().innerText().catch(() => '');
    check('composer 标签显示所选成员', selectedLabel.includes(AGENT_NAME), `label=${JSON.stringify(selectedLabel.trim())}`);

    // ---- 2. 发一轮真实消息 ----
    const handle = await page.evaluateHandle(() => {
        const list = Array.from(document.querySelectorAll('textarea')).filter((el) => el.offsetParent !== null);
        const inComposer = list.filter((el) => el.closest('.pd-composer-control-row'));
        return (inComposer[0] || list[list.length - 1] || null);
    });
    const textarea = handle.asElement();
    check('找到输入框', Boolean(textarea), 'textarea in composer');
    if (!textarea) throw new Error('composer textarea not found');
    await page.waitForTimeout(300);
    const prompt = '【界面自检】请用一句话说明你的身份名称，不要调用任何工具。';
    await textarea.fill(prompt);
    await textarea.press('Enter');
    console.log('SENT:', prompt);

    // 等回复（带发言人名字）
    const speakerSelector = `[data-testid="assistant-message-speaker"]`;
    await page.waitForFunction(
        ({ sel, name }) => Array.from(document.querySelectorAll(sel)).some((el) => (el.textContent || '').trim() === name),
        { sel: speakerSelector, name: AGENT_NAME },
        { timeout: 300000 },
    ).catch(() => null);

    const speakerInfo = await page.evaluate(({ sel, name }) => {
        const buttons = Array.from(document.querySelectorAll(sel));
        const target = buttons.find((el) => (el.textContent || '').trim() === name);
        return {
            total: buttons.length,
            texts: buttons.map((el) => (el.textContent || '').trim()),
            found: Boolean(target),
            className: target ? target.getAttribute('class') : null,
            title: target ? target.getAttribute('title') : null,
        };
    }, { sel: speakerSelector, name: AGENT_NAME });
    check('回复带出团队成员名字', speakerInfo.found, `speakers=${JSON.stringify(speakerInfo.texts)}`);
    const className = speakerInfo.className || '';
    const colorMatch = className.match(/text-(violet|purple|fuchsia|amber|orange|yellow|blue|sky|indigo|emerald|teal|green|rose|cyan|lime)-(\d+)/);
    check('成员回复使用独立颜色', Boolean(colorMatch), `class=${className} color=${colorMatch ? colorMatch[0] : 'none'}`);

    // ---- 3. 条带列出发言人并可筛选 ----
    const chips = await page.evaluate(() => Array.from(document.querySelectorAll('[data-testid="speaker-filter-item"]')).map((el) => ({
        key: el.getAttribute('data-speaker-key'),
        label: (el.textContent || '').trim(),
        ariaLabel: el.getAttribute('aria-label'),
        pressed: el.getAttribute('aria-pressed'),
    })));
    check('条带列出发言人', chips.length > 0, `chips=${JSON.stringify(chips)}`);

    const beforeCount = speakerInfo.texts.length;
    const chip = page.locator(`[data-speaker-key="name:${AGENT_NAME}"]`);
    const chipExists = await chip.count();
    check('条带含该成员筛选项', chipExists > 0, `key=name:${AGENT_NAME}`);
    if (chipExists > 0) {
        await chip.first().click();
        await page.waitForTimeout(900);
        const after = await page.evaluate((sel) => Array.from(document.querySelectorAll(sel)).map((el) => (el.textContent || '').trim()), speakerSelector);
        const others = after.filter((t) => t !== AGENT_NAME);
        check('筛选后只剩该成员发言', others.length === 0 && after.length > 0, `after=${JSON.stringify(after)} (before=${beforeCount})`);
        const pressed = await chip.first().getAttribute('aria-pressed');
        check('筛选项进入选中态', pressed === 'true', `aria-pressed=${pressed}`);
        await page.screenshot({ path: `${OUT_DIR}/speaker-filter-active.png`, fullPage: false });

        await page.locator('[data-testid="speaker-filter-team"]').click();
        await page.waitForTimeout(900);
        const restored = await page.evaluate((sel) => Array.from(document.querySelectorAll(sel)).map((el) => (el.textContent || '').trim()), speakerSelector);
        const teamPressed = await page.locator('[data-testid="speaker-filter-team"]').getAttribute('aria-pressed');
        check('点「团队」恢复全部发言人', restored.length >= after.length && teamPressed === 'true', `restored=${JSON.stringify(restored)} team-pressed=${teamPressed}`);
    }
    await page.screenshot({ path: `${OUT_DIR}/speaker-strip.png`, fullPage: false });

    console.log('CONSOLE ERRORS:', JSON.stringify(consoleErrors.slice(0, 6)));
} finally {
    await browser.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\nSUMMARY: ${results.length - failed.length}/${results.length} passed`);
if (failed.length) {
    console.log('FAILED:', JSON.stringify(failed, null, 2));
    process.exit(1);
}
