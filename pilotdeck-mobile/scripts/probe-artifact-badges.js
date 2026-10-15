import { chromium } from '/vol3/1000/Work/00/PilotV/pilotdeck-mobile/upstream-official/ui/node_modules/playwright-core/index.mjs';
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errs = [];
const calls = [];
page.on('pageerror', e => errs.push(String(e).slice(0, 160)));
page.on('request', r => { if (/artifacts/.test(r.url())) calls.push('REQ ' + r.url().slice(-40)); });
page.on('response', r => { if (/artifacts/.test(r.url())) calls.push('RES ' + r.status() + ' ' + r.url().slice(-40)); });
await page.goto('http://127.0.0.1:5186', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction(() => !/Loading\.\.\./.test(document.body.innerText), null, { timeout: 90000 });
await page.waitForTimeout(2000);
// 会话是增量加载的，等项目下所有会话都到齐再判断。
await page.waitForFunction(() => document.querySelectorAll('button.project-conversation').length > 20, null, { timeout: 60000 }).catch(() => {});
await page.waitForTimeout(2500);
await page.locator('button.project-expand-button').filter({ hasText: /^PilotV$/ }).first().click();
await page.waitForTimeout(1500);

const read = () => page.evaluate(() => Array.from(document.querySelectorAll('button.project-conversation'))
  .map(b => { const badge = b.querySelector('[data-testid^="artifact-count-"]'); return (b.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 26) + (badge ? ' [BADGE:' + badge.textContent.trim() + ']' : ''); }));

const expanded = await read();
await page.screenshot({ path: '/tmp/badges-expanded.png' });
const showLess = page.getByText('Show less').first();
const hadShowLess = await showLess.count();
if (hadShowLess) { await showLess.click(); await page.waitForTimeout(900); }
const collapsed = await read();
await page.screenshot({ path: '/tmp/badges-collapsed.png' });
const diag = await page.evaluate(async () => {
  const r = await fetch('/api/artifacts/workspace');
  const d = await r.json();
  const first = d.projects?.[0]?.sessions?.find(s => (s.artifacts || []).length > 0);
  const badgeIds = Array.from(document.querySelectorAll('[data-testid^="artifact-count-"]')).map(e => e.getAttribute('data-testid'));
  return { apiSessionId: first?.id, apiCount: (first?.artifacts || []).length, badgeIds };
});
console.log(JSON.stringify({ hadShowLess, diag, artifactCalls: calls, expanded: expanded.slice(0, 30), collapsed: collapsed.slice(0, 30), errs }, null, 2));
await browser.close();
