/**
 * 打开 5186 的成果页，抓取控制台报错、网络失败和实际渲染出来的内容。
 * 目的是区分「接口没数据」和「有数据但画不出来」。
 */
import { chromium } from '/vol3/1000/Work/00/PilotV/pilotdeck-mobile/upstream-official/ui/node_modules/playwright-core/index.mjs';

const BASE = process.env.BASE || 'http://127.0.0.1:5186';
const SESSION = process.env.SESSION || '';

(async () => {
  const browser = await chromium.launch({
    executablePath: '/usr/bin/google-chrome',
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const console_ = [];
  const failed = [];
  page.on('console', m => { if (m.type() === 'error') console_.push(m.text().slice(0, 300)); });
  page.on('pageerror', e => console_.push('PAGEERROR ' + String(e).slice(0, 300)));
  const all = [];
  const ws = [];
  page.on('websocket', w => {
    ws.push('OPEN ' + w.url());
    w.on('socketerror', e => ws.push('ERROR ' + e));
    w.on('close', () => ws.push('CLOSED ' + w.url()));
    w.on('framereceived', f => { const t = String(f.payload || ''); let tag='RECV'; try { tag += ' ' + (JSON.parse(t).type||'?') + ' ' + t.length + 'B'; } catch { tag += ' raw'; } if (ws.length < 400) ws.push(tag); });
    w.on('framesent', f => { const t = String(f.payload || '').slice(0, 120); if (ws.length < 40) ws.push('SENT ' + t); });
  });
  page.on('response', r => { all.push(`${r.status()} ${r.request().method()} ${r.url().slice(0, 160)}`); });
  page.on('requestfailed', r => failed.push(`FAILED ${r.url().slice(0, 160)} :: ${r.failure()?.errorText}`));

  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(Number(process.env.WAIT || 4000));

  // 切到成果页
  const artifactsBtn = page.getByRole('button', { name: '成果' });
  if (await artifactsBtn.count()) {
    await artifactsBtn.first().click();
    await page.waitForTimeout(3000);
  }

  const report = await page.evaluate(() => {
    const text = document.body.innerText || '';
    return {
      url: location.href,
      hasArtifactsButton: !!document.querySelector('[aria-label="成果"]'),
      bodySnippet: text.slice(0, 1200),
      images: Array.from(document.querySelectorAll('img')).map(i => ({
        src: (i.currentSrc || i.src || '').slice(0, 120),
        w: i.clientWidth, h: i.clientHeight, complete: i.complete, natural: i.naturalWidth,
      })),
      iframes: Array.from(document.querySelectorAll('iframe')).map(f => ({
        src: (f.src || '').slice(0, 120), w: f.clientWidth, h: f.clientHeight,
      })),
      videoTags: document.querySelectorAll('video').length,
      frameBox: (() => {
        const el = document.querySelector('[data-testid="artifact-frame"]');
        if (!el) return null;
        const r = el.getBoundingClientRect();
        const img = el.querySelector('img');
        const ir = img ? img.getBoundingClientRect() : null;
        return {
          frame: [Math.round(r.width), Math.round(r.height)],
          paddingTop: getComputedStyle(el).paddingTop,
          overflow: getComputedStyle(el).overflow,
          img: ir ? [Math.round(ir.width), Math.round(ir.height)] : null,
          imgSrc: img ? (img.currentSrc || img.src || '').slice(0, 120) : null,
        };
      })(),
      zoomGroup: !!document.querySelector('[aria-label="成果缩放"]'),
    };
  });

  const pending = await page.evaluate(() => performance.getEntriesByType('resource')
    .filter(e => !e.responseEnd)
    .map(e => 'PENDING ' + e.name.slice(0, 160)));
  console.log(JSON.stringify({ report, consoleErrors: console_, failedRequests: failed, pending, websockets: ws, allRequests: all }, null, 2));
  await page.screenshot({ path: '/tmp/artifacts-page.png', fullPage: false });
  await browser.close();
})().catch(e => { console.error('FATAL', e); process.exit(1); });