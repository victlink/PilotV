// PilotV 成果页真实验收：框选能存、手绘能画、没有成果时有空白页。
//
//     node pilotdeck-mobile/scripts/artifacts-ink-accept.mjs
//
// 针对的就是手机上「框选了但保存按钮在屏幕外」和「没有产物就没法标注」这两件事。
// 所有断言都打在真实 DOM 上，并且每一条标注在结束前都会删掉 —— 验收不许往正式库里留数据。
import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
const require = createRequire('/home/Marc/PilotDeck-src/node_modules/.pnpm/playwright@1.60.0/node_modules/playwright/package.json');
const { chromium } = require('playwright');

const BASE = process.env.BASE_URL || 'http://127.0.0.1:5186/';
const PROJECT_TITLE = process.env.PROJECT_TITLE || 'PilotV';
const WITH_ARTIFACTS = process.env.SESSION_WITH_ARTIFACTS || '设计 PilotV logo';
const WITHOUT_ARTIFACTS = process.env.SESSION_WITHOUT_ARTIFACTS || '排查网页无法打开问题';
const VIEWPORT = process.env.PHONE_VIEWPORT === 'desktop'
  ? { width: 1440, height: 900 }
  : { width: 390, height: 844 };
const review = 'pilotdeck-mobile/review';
const repoRoot = new URL('../..', import.meta.url).pathname.replace(/\/$/, '');
await mkdir(review, { recursive: true });

const browser = await chromium.launch({
  headless: true,
  executablePath: '/home/Marc/.cache/ms-playwright/chromium-1237/chrome-linux64/chrome',
  args: ['--no-sandbox'],
});
const context = await browser.newContext({
  viewport: VIEWPORT,
  hasTouch: true,
  isMobile: VIEWPORT.width < 1024,
  // 验收要验的是刚构建出来的那份 bundle；让 service worker 缓存会验到旧包。
  serviceWorkers: 'block',
});
const page = await context.newPage();
const problems = [];
const created = [];
page.on('pageerror', error => problems.push(`pageerror: ${error.message}`));

const shot = name => page.screenshot({ path: `${review}/${name}.png`, timeout: 20000 });
const step = async (label, fn) => {
  try {
    const value = await fn();
    console.log(`PASS  ${label}${value ? ` — ${value}` : ''}`);
    return value;
  } catch (error) {
    console.log(`FAIL  ${label}: ${error.message}`);
    problems.push(`${label}: ${error.message}`);
    // 失败也要留证据，否则只能靠猜。
    await page.screenshot({ path: `${review}/FAIL-${label.slice(0, 12)}.png` }).catch(() => undefined);
    return null;
  }
};

// 先用宽视口把会话选好，再缩到目标视口跑交互断言。
// 手机版外壳（侧栏抽屉 + 项目树启动较慢）和成果页交互是两件事，
// 混在一起跑只会在外壳上翻车，测不到“手机上能不能框选/手绘”这个真问题。
async function openSession(title) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: PROJECT_TITLE, exact: true }).first().click({ timeout: 30000 });
  const session = page.getByText(title, { exact: false }).first();
  for (let attempt = 0; attempt < 6 && !(await session.isVisible().catch(() => false)); attempt += 1) {
    const more = page.getByRole('button', { name: /Show more|显示更多|展开/ }).first();
    if (!await more.isVisible().catch(() => false)) break;
    await more.click();
    await page.waitForTimeout(400);
  }
  await session.waitFor({ timeout: 60000 });
  // 这台机器上外壳每个请求要几秒，点会话要留足时间，否则会误判成功能失败。
  await session.click({ timeout: 60000 });
  await page.getByRole('navigation', { name: '对话与成果切换' }).waitFor({ timeout: 60000 });
  if (VIEWPORT.width < 1024) {
    await page.setViewportSize(VIEWPORT);
    await page.waitForTimeout(1200);
  }
}

async function openArtifacts() {
  await page.getByRole('navigation', { name: '对话与成果切换' }).getByRole('button', { name: '成果' }).click();
  await page.getByRole('region', { name: '当前会话成果' }).waitFor({ timeout: 20000 });
}

const stage = () => page.locator('[data-testid="ink-canvas"]');
const stageBox = () => page.locator('[role="application"][aria-label*="手绘"], div.relative.shrink-0').first().boundingBox();

/** 拖出一块框。走真实 pointer 事件，和手指／触控笔同一条路径。 */
async function dragBox(box) {
  const x = box.x + box.width * 0.25;
  const y = box.y + box.height * 0.25;
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (let step = 1; step <= 8; step += 1) {
    await page.mouse.move(x + (box.width * 0.35 * step) / 8, y + (box.height * 0.35 * step) / 8);
    await page.waitForTimeout(16);
  }
  await page.mouse.up();
  await page.waitForTimeout(200);
}

/** 在画布上画一条带压感的笔迹。 */
async function drawStroke(box) {
  const points = [];
  for (let i = 0; i <= 14; i += 1) {
    points.push({
      x: box.x + box.width * (0.25 + 0.03 * i),
      y: box.y + box.height * (0.55 + 0.08 * Math.sin(i / 2)),
      pressure: 0.4 + 0.5 * Math.abs(Math.sin(i / 3)),
    });
  }
  await page.mouse.move(points[0].x, points[0].y);
  await page.mouse.down();
  for (const point of points.slice(1)) {
    await page.mouse.move(point.x, point.y);
    await page.waitForTimeout(12);
  }
  await page.mouse.up();
  await page.waitForTimeout(250);
}

async function saveDraft(body) {
  const input = page.locator('#artifact-note-draft');
  await input.waitFor({ timeout: 8000 });
  await input.fill(body);
  const wait = page.waitForResponse(
    response => response.url().includes('/annotations') && response.request().method() === 'POST',
    { timeout: 15000 },
  );
  await page.getByRole('button', { name: '保存标注' }).click();
  const response = await wait;
  // 必须记下新建标注的 id：POST 的 URL 只有 .../annotations，没有 /annotations/{nid}，
  // 早先只存 URL 导致清理阶段拼不出 DELETE 地址，测试标注就一直留在正式库。
  const artifactId = /\/api\/artifacts\/([^/]+)\/annotations/.exec(response.url())?.[1];
  const payload = await response.json().catch(() => null);
  const noteId = payload?.annotation?.id ?? payload?.id;
  if (artifactId && noteId) created.push({ artifactId, noteId });
  else throw new Error(`没拿到标注 id，无法清理：url=${response.url()} payload=${JSON.stringify(payload)}`);
  return response.status();
}

/**
 * 验收数据必须清干净，而且要**查库确认**，不能只点几下删除按钮就当成功。
 * 之前就是「尝试清理 N 条」但正式库里仍留着测试标注和测试白板。
 */
async function cleanup() {
  if (!created.length) return '';
  const removed = await page.evaluate(async items => {
    const log = [];
    // 按记录的 id 删一遍
    for (const { artifactId, noteId } of items) {
      const res = await fetch(`/api/artifacts/${artifactId}/annotations/${noteId}`, { method: 'DELETE' });
      log.push(`${noteId}→${res.status}`);
    }
    // 再扫一遍每个被碰过的成果：前端有时会多写一条（模式切换时自动落笔、
    // 或者提交的 POST 是异步落地的），只按记录删会漏，所以扫两遍并留出落地时间。
    const touched = new Set(items.map(i => i.artifactId));
    for (let pass = 0; pass < 3 && touched.size; pass += 1) {
      await new Promise(r => setTimeout(r, 1500));
      for (const artifactId of touched) {
        const detail = await fetch(`/api/artifacts/${artifactId}`).then(r => r.json()).catch(() => null);
        for (const note of detail?.annotations || []) {
          if (!/^验收：/.test(note.body || '')) continue;
          const res = await fetch(`/api/artifacts/${artifactId}/annotations/${note.id}`, { method: 'DELETE' });
          log.push(`sweep${pass} ${note.id}→${res.status}`);
        }
      }
    }
    return log;
  }, created);
  return `删除 ${removed.length} 次（${removed.join(', ')}）`;
}

/** 收尾时复查正式库，确认测试标注真的没了，否则验收不算通过。 */
async function assertProductionDbClean() {
  const left = await page.evaluate(async () => {
    const list = await fetch('/api/artifacts?limit=500').then(r => r.json()).catch(() => null);
    const hits = [];
    for (const artifact of (list?.artifacts || [])) {
      const detail = await fetch(`/api/artifacts/${artifact.id}`).then(r => r.json()).catch(() => null);
      for (const note of detail?.annotations || []) {
        if (/^验收：/.test(note.body || '')) hits.push(`${artifact.id}/${note.id} ${note.body}`);
      }
      if (artifact.agent === 'pilotv-reviewer') hits.push(`${artifact.id} 白板未清理`);
    }
    return hits;
  });
  if (left.length) throw new Error(`正式库仍有验收残留：${left.join(' | ')}`);
  return '正式库无验收残留';
}

/**
 * 白板成果没有删除接口，验收自己产生的那张只能直接清库。
 * 护栏写死：只删 agent='pilotv-reviewer' 且标题是本次验收专用的那些行。
 */
function dropTestWhiteboards() {
  const result = spawnSync('python3', ['-c', `
import sqlite3
db = sqlite3.connect('.artifacts-data/artifacts.db', timeout=10)
db.execute("delete from annotations where artifact_id in (select id from artifacts where agent='pilotv-reviewer')")
db.execute("delete from artifacts where agent='pilotv-reviewer' and title like '手绘草稿%'")
db.commit()
print(db.execute("select count(*) from artifacts where agent='pilotv-reviewer'").fetchone()[0])
`], { cwd: repoRoot, encoding: 'utf8' });
  return result.status === 0 ? `白板剩余 ${result.stdout.trim()}` : `白板清理失败：${result.stderr.trim().slice(0, 120)}`;
}

try {
  await step('打开有成果的会话并进入成果页', async () => {
    await openSession(WITH_ARTIFACTS);
    await openArtifacts();
    return `${VIEWPORT.width}x${VIEWPORT.height}`;
  });

  await step('框选之后保存按钮在可视范围内（手机上的关键回归点）', async () => {
    const box = await stageBox();
    if (!box) throw new Error('成果舞台没有渲染出来');
    await dragBox(box);
    const bar = page.locator('#artifact-note-draft');
    await bar.waitFor({ timeout: 8000 });
    const barBox = await bar.boundingBox();
    const viewport = page.viewportSize();
    if (!barBox) throw new Error('标注编辑框没有尺寸');
    if (barBox.y + barBox.height > viewport.height + 1) {
      throw new Error(`保存框在屏幕外：底边 ${Math.round(barBox.y + barBox.height)} > 视口高 ${viewport.height}`);
    }
    await shot('ink-01-box-draft-reachable');
    return `编辑框底边 ${Math.round(barBox.y + barBox.height)} ≤ ${viewport.height}`;
  });

  await step('框选能存下标注并回到画面上', async () => {
    const status = await saveDraft('验收：框选标注');
    if (status !== 200 && status !== 201) throw new Error(`保存返回 HTTP ${status}`);
    // 断言打在右侧标注清单上：画布上的角标在非框选模式下不是 button，
    // 拿 role 去定位会误判成“没保存”。
    await page.getByRole('region', { name: '当前会话成果' }).getByText('验收：框选标注', { exact: false })
      .first().waitFor({ timeout: 10000 });
    await shot('ink-02-box-saved');
    return `HTTP ${status}`;
  });

  await step('切到手绘模式并在成果上画一笔', async () => {
    await page.getByRole('button', { name: '手绘', exact: true }).click();
    await stage().waitFor({ timeout: 8000 });
    await page.waitForTimeout(300);
    const box = await stage().boundingBox();
    await drawStroke(box);
    await page.waitForTimeout(400);
    const probe = await page.evaluate(() => {
      const cv = document.querySelector('[data-testid="ink-canvas"]');
      const input = document.querySelector('#artifact-note-draft');
      let painted = 0;
      if (cv) {
        const data = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
        for (let i = 3; i < data.length; i += 4) if (data[i] !== 0) painted += 1;
      }
      return {
        tool: Array.from(document.querySelectorAll('button[aria-pressed="true"]')).map(b => b.textContent),
        painted,
        draftAttached: !!input,
        draftVisible: input ? input.getClientRects().length > 0 : false,
      };
    });
    if (!probe.draftVisible) throw new Error(`笔迹没进入待保存标注：${JSON.stringify(probe)}`);
    const bar = page.locator('#artifact-note-draft');
    await bar.waitFor({ timeout: 8000 });
    const label = await page.locator('label[for="artifact-note-draft"]').innerText();
    if (!label.includes('笔')) throw new Error(`笔迹没有进入待保存标注：${label}`);
    await shot('ink-03-ink-drawn');
    return `${label}（画布已落墨 ${probe.painted} 像素）`;
  });

  await step('手绘能存下笔迹', async () => {
    const status = await saveDraft('验收：手绘标注');
    if (status !== 200 && status !== 201) throw new Error(`保存返回 HTTP ${status}`);
    await page.getByRole('region', { name: '当前会话成果' }).getByText('验收：手绘标注', { exact: false })
      .first().waitFor({ timeout: 10000 });
    await shot('ink-04-ink-saved');
    return `HTTP ${status}`;
  });

  await step('没有成果的会话给出空白手绘页', async () => {
    await openSession(WITHOUT_ARTIFACTS);
    await openArtifacts();
    await stage().waitFor({ timeout: 45000 });
    const hint = await page.getByRole('region', { name: '当前会话成果' }).innerText();
    if (!hint.includes('空白手绘页')) throw new Error(`空白页没有出现，实际内容：${hint.slice(0, 120)}`);
    await shot('ink-05-blank-sheet');
    return '空白页已渲染';
  });

  await step('空白页上也能画、也能存（保存时自动建白板成果）', async () => {
    // 空白页出厂就是手绘模式，不用先点工具栏。
    await stage().waitFor({ timeout: 8000 });
    const box = await stage().boundingBox();
    await drawStroke(box);
    const status = await saveDraft('验收：空白页手绘');
    if (status !== 200 && status !== 201) throw new Error(`保存返回 HTTP ${status}`);
    await page.getByRole('region', { name: '当前会话成果' }).getByText('验收：空白页手绘', { exact: false })
      .first().waitFor({ timeout: 15000 });
    await shot('ink-06-blank-saved');
    return `HTTP ${status}`;
  });

  await step('清掉验收期间写进正式库的标注', async () => {
    const detail = await cleanup();
    const boards = dropTestWhiteboards();
    // 删除后必须复查正式库；残留测试数据会让这次验收失去意义。
    const clean = await assertProductionDbClean();
    return `${detail}；${boards}；${clean}`;
  });
} finally {
  await page.context().close().catch(() => undefined);
  await browser.close().catch(() => undefined);
}

console.log(`\nview=${VIEWPORT.width}x${VIEWPORT.height} screenshots in ${review}/`);
if (problems.length) {
  console.log('\nPROBLEMS:');
  for (const item of problems) console.log(' -', item);
  process.exitCode = 1;
} else {
  console.log('\nOK: 框选、手绘、空白页全部通过');
}