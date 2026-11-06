/**
 * 折叠状态验证：检查真实会话里「已完成的独立回复」是否默认折叠，
 * 以及折叠按钮是否可点击展开。
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';

const require = createRequire(
  '/vol3/1000/Work/00/PilotV/pilotdeck-mobile/upstream-official/ui/package.json',
);
const { chromium } = require(
  '/home/Marc/PilotDeck-src/node_modules/.pnpm/playwright@1.60.0/node_modules/playwright',
);
const Database = require('better-sqlite3');
const jwt = require('jsonwebtoken');

const BASE_URL = process.argv[2] || 'http://127.0.0.1:5187';
const OUT_DIR = process.argv[3] || '/tmp/smoke-collapse';

const db = new Database('/home/Marc/.pilotdeck/auth.db', { readonly: true });
const row = db.prepare('select value from app_config where key = ?').get('jwt_secret');
db.close();
const token = jwt.sign({ userId: 1, username: 'Marc' }, row.value, { expiresIn: '30m' });

fs.mkdirSync(OUT_DIR, { recursive: true });

const browser = await chromium.launch({
  executablePath: process.env.SMOKE_CHROME || '/usr/bin/google-chrome',
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN' });
await context.addInitScript(
  ({ tok }) => {
    const m = {};
    for (const o of ['http://127.0.0.1:5187', 'http://127.0.0.1:3001']) m[o] = tok;
    try { localStorage.setItem('pilotdeck-tokens', JSON.stringify(m)); } catch {}
    try { localStorage.setItem('auth-token', tok); } catch {}
    try { localStorage.setItem('userLanguage', 'zh-CN'); } catch {}
  },
  { tok: token },
);

const page = await context.newPage();
await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(8000);

const result = await page.evaluate(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  for (let i = 0; i < 6; i += 1) {
    for (const b of document.querySelectorAll('.project-expand-button')) {
      try { b.click(); await sleep(280); } catch {}
    }
  }
  await sleep(1200);

  const buttons = Array.from(document.querySelectorAll('button.project-conversation'));
  const found = [];

  for (const b of buttons.slice(0, 25)) {
    const label = (b.textContent || '').trim().slice(0, 30);
    try { b.click(); } catch { continue; }
    await sleep(1200);

    const expandBtn = document.querySelector('[data-testid="assistant-message-expand"]');
    const rowEls = document.querySelectorAll('[data-testid="assistant-message-speaker"]');
    if (!rowEls.length) continue;

    // 统计正文容器与折叠按钮
    const bodySel = '.prose';
    const bodies = Array.from(document.querySelectorAll(bodySel));
    const entry = {
      session: label,
      speakerRows: rowEls.length,
      expandButtons: document.querySelectorAll('[data-testid="assistant-message-expand"]').length,
      expandLabels: Array.from(document.querySelectorAll('[data-testid="assistant-message-expand"]')).map(
        (x) => (x.textContent || '').trim().slice(0, 20),
      ),
      bodyBlocks: bodies.length,
      bodyChars: bodies.map((x) => (x.innerText || '').trim().length),
    };
    found.push(entry);

    if (entry.expandButtons > 0) {
      // 点一下展开按钮，验证可以展开
      const before = document.querySelectorAll(bodySel).length;
      expandBtn.click();
      await sleep(900);
      const after = document.querySelectorAll(bodySel).length;
      entry.afterClickBodyBlocks = after;
      entry.afterClickBodyChars = Array.from(document.querySelectorAll(bodySel)).map(
        (x) => (x.innerText || '').trim().length,
      );
      entry.expandedWorked = after > before || JSON.stringify(entry.bodyChars) !== JSON.stringify(entry.afterClickBodyChars);
      break;
    }
  }
  return found;
});

console.log(JSON.stringify({ baseUrl: BASE_URL, sessions: result }, null, 2));
await browser.close();
