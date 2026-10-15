// 检查侧栏「探索」分区：默认收起、点标题展开、展开后条目可见，
// 并和「项目」的折叠标题形态一致。用法：
//   node review/explore-section-check.mjs [url]
// playwright 装在前端工程里，这里按那个位置解析，不往项目根再装一份。
import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const uiDir = path.resolve(here, '../pilotdeck-mobile/upstream-official/ui');
const { chromium } = createRequire(path.join(uiDir, 'package.json'))('playwright');

const url = process.argv[2] || process.env.PILOTV_URL || 'http://127.0.0.1:5186/';
const outDir = `${here}/`;

// playwright 自带的那版 headless shell 没装，直接用缓存里已有的 chromium。
const chromiumPath = process.env.PILOTV_CHROMIUM
  || '/home/Marc/.cache/ms-playwright/chromium-1237/chrome-linux64/chrome';
const browser = await chromium.launch({
  headless: true,
  executablePath: existsSync(chromiumPath) ? chromiumPath : undefined,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});

const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(3000);

const measure = () => page.evaluate(() => {
  const section = document.querySelector('.explore-section');
  const exploreToggle = section?.querySelector('.tree-heading button');
  const projectsToggle = document.querySelector('.tree-section .tree-heading button');
  const sidebar = document.querySelector('.project-sidebar');
  const sidebarRect = sidebar?.getBoundingClientRect();
  return {
    path: location.pathname,
    pageHeading: document.querySelector('h1, h2')?.textContent?.trim() ?? null,
    sidebarVisible: Boolean(sidebarRect && sidebarRect.width > 0 && sidebarRect.height > 0),
    sidebarWidth: sidebarRect ? Math.round(sidebarRect.width) : null,
    projectsToggle: projectsToggle?.innerText?.trim() ?? null,
    projectsAriaExpanded: projectsToggle?.getAttribute('aria-expanded') ?? null,
    exploreHeading: exploreToggle?.innerText?.trim() ?? null,
    exploreAriaExpanded: exploreToggle?.getAttribute('aria-expanded') ?? null,
    exploreRows: [...(section?.querySelectorAll('.explore-row') ?? [])].map(row => ({
      label: row.textContent?.trim(),
      current: row.getAttribute('aria-current'),
    })),
    exploreSectionHeight: section ? Math.round(section.getBoundingClientRect().height) : null,
  };
});

await mkdir(outDir, { recursive: true });
await page.screenshot({ path: `${outDir}/explore-collapsed.png` });
const collapsed = await measure();

await page.locator('.explore-section .tree-heading button').first().click();
await page.waitForTimeout(400);
const expanded = await measure();
await page.screenshot({ path: `${outDir}/explore-expanded.png` });

await page.locator('.explore-section .tree-heading button').first().click();
await page.waitForTimeout(400);
const recollapsed = await measure();

// 侧栏收窄成图标栏时，探索分区和设置入口都要还在。
await page.setViewportSize({ width: 1440, height: 900 });
const compactWidth = await page.evaluate(() => {
  const slider = document.querySelector('.sidebar-resizer');
  return Boolean(slider);
});
await page.screenshot({ path: `${outDir}/explore-recollapsed.png` });

console.log(JSON.stringify({ collapsed, expanded, recollapsed, hasResizer: compactWidth }, null, 2));
await browser.close();