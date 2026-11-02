/**
 * Composer bottom bar probe.
 *
 * Renders the real ComposerV2 inside a width-constrained box with the real
 * stylesheet and reports how many visual rows the bottom control bar takes.
 * The composer bottom bar must stay on a single line on phone widths.
 *
 * Usage: node pilotdeck-mobile/scripts/browser-smoke-composer-row.mjs
 */
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const require = createRequire(
  '/home/Marc/PilotDeck-src/node_modules/.pnpm/playwright@1.60.0/node_modules/playwright/package.json',
);
const { chromium } = require('playwright');

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const UI_DIR = path.resolve(REPO, 'pilotdeck-mobile/upstream-official/ui');
const OUT_DIR = path.resolve(REPO, 'pilotdeck-mobile/review/composer');
const PROBE_DIR = path.resolve(REPO, 'pilotdeck-mobile/scripts/composer-probe');
const PORT = Number(process.env.PROBE_PORT || 5199);

const uiRequire = createRequire(path.join(UI_DIR, 'package.json'));
const vite = await import(uiRequire.resolve('vite'));
// Tailwind resolves its config from the process cwd, so run inside the UI package.
process.chdir(UI_DIR);

const measure = async () => {
  const row = document.querySelector('.pd-composer-control-row');
  const container = document.querySelector('.pd-composer-container');
  if (!row || !container) return { error: 'composer not found' };
  const box = (el) => {
    const r = el.getBoundingClientRect();
    return { left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) };
  };
  const controlCandidates = [
    ...row.querySelectorAll(
      'button, select, input, [role="button"], .pd-composer-selection-chip, .pd-composer-agent-control, .pd-composer-model-control, .pd-composer-context-control',
    ),
  ].filter(
    (el) => !controlCandidatesIncludes(el),
  );
  // Keep only the outermost element of every control group.
  function controlCandidatesIncludes(el) {
    let node = el.parentElement;
    while (node && node !== row) {
      if (
        node.matches(
          'button, select, input, [role="button"], .pd-composer-selection-chip, .pd-composer-agent-control, .pd-composer-model-control, .pd-composer-context-control',
        )
      ) {
        return true;
      }
      node = node.parentElement;
    }
    return false;
  }
  // Keep only the outermost element of every control group.
  const controls = controlCandidates
    .filter((el) => el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().height > 0)
    .map((el) => ({
      label: (el.getAttribute('title') || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 28),
      text: (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 20),
      maxWidth: getComputedStyle(el).maxWidth,
      ...box(el),
    }));
  // Controls belong to the same visual row when their vertical centres are close.
  const centres = controls.map((c) => (c.top + c.height / 2)).sort((a, b) => a - b);
  let rows = 0;
  let last = null;
  for (const centre of centres) {
    if (last === null || centre - last > 6) rows += 1;
    last = centre;
  }
  // Two controls that share a row must not overlap horizontally.
  const ordered = [...controls].sort((a, b) => a.left - b.left);
  const overlaps = [];
  for (let i = 1; i < ordered.length; i += 1) {
    if (ordered[i].left < ordered[i - 1].right - 1) {
      overlaps.push(`${ordered[i - 1].label} / ${ordered[i].label}`);
    }
  }
  // A trigger whose content is wider than its box spills over the neighbour.
  const spill = [...row.querySelectorAll('.pd-composer-select-trigger')].filter((el) => {
    const box = el.getBoundingClientRect();
    const content = [...el.children].reduce(
      (sum, child) => sum + child.getBoundingClientRect().width,
      0,
    );
    return content > box.width + 1;
  }).length;
  const rowStyle = getComputedStyle(row);
  const gap = parseFloat(rowStyle.columnGap || rowStyle.gap || '0') || 0;
  // Geometry of the two dropdown wrappers: the trigger has to stay inside them.
  const dropdowns = [
    ...row.querySelectorAll('.pd-composer-agent-control, .pd-composer-model-control'),
  ].map((el) => {
    const trigger = el.querySelector('button');
    const label = trigger ? trigger.querySelector('span') : null;
    const kids = trigger
      ? [...trigger.children].map((child) => {
          const r = child.getBoundingClientRect();
          return {
            tag: child.tagName.toLowerCase(),
            cls: (child.getAttribute('class') || '').split(' ').slice(0, 2).join(' '),
            left: Math.round(r.left),
            right: Math.round(r.right),
            width: Math.round(r.width),
            text: (child.textContent || '').trim().slice(0, 12),
            truncated: child.scrollWidth > child.clientWidth + 1,
            scrollWidth: child.scrollWidth,
            fontSize: getComputedStyle(child).fontSize,
          };
        })
      : [];
    return {
      name: el.className.includes('agent') ? 'agent' : 'model',
      wrapper: box(el),
      trigger: trigger ? box(trigger) : null,
      labelText: label ? (label.textContent || '').trim() : '',
      kids,
    };
  });
  const items = [...row.children].flatMap((child) =>
    getComputedStyle(child).display === 'contents' ? [...child.children] : [child],
  );
  const used = items.reduce((sum, el) => sum + el.getBoundingClientRect().width, 0);
  const free = Math.round(row.clientWidth - used - gap * Math.max(0, items.length - 1));
  return {
    rows,
    controls,
    overlaps,
    spill,
    dropdowns,
    free,
    rowBox: box(row),
    rowOverflow: row.scrollWidth > row.clientWidth + 1,
    containerOverflow: container.scrollWidth > container.clientWidth + 1,
    containerBox: box(container),
    containerClient: container.clientWidth,
    rowClient: row.clientWidth,
    viewport: { width: window.innerWidth, height: window.innerHeight },
  };
};

const results = [];
const server = await vite.createServer({
  root: UI_DIR,
  configFile: path.join(UI_DIR, 'vite.config.js'),
  logLevel: 'error',
  resolve: {
    alias: {
      'probe-css': path.join(UI_DIR, 'src/index.css'),
      'probe-i18n': path.join(UI_DIR, 'src/i18n/config.js'),
      'probe-composer': path.join(UI_DIR, 'src/components/chat-v2/ComposerV2.tsx'),
    },
  },
  plugins: [
    {
      name: 'pilotv-composer-probe',
      configureServer(viteServer) {
        // The probe page lives outside the UI package so the vendored upstream
        // tree stays untouched.
        viteServer.middlewares.use('/probe/composer-row.html', async (_req, res) => {
          const html = await readFile(path.join(PROBE_DIR, 'index.html'), 'utf8');
          const entry = path.join(PROBE_DIR, 'composer-row.tsx');
          res.setHeader('Content-Type', 'text/html');
          res.end(html.replace('/@fs/PROBE_ENTRY', `/@fs${entry}`));
        });
      },
    },
  ],
  server: {
    host: '127.0.0.1',
    port: PORT,
    strictPort: true,
    // Fast refresh would inject $RefreshSig$ into the out-of-root probe entry.
    hmr: false,
    fs: { allow: [UI_DIR, PROBE_DIR] },
  },
});
await server.listen();
const browser = await chromium.launch({
  headless: true,
  executablePath: '/home/Marc/.cache/ms-playwright/chromium-1237/chrome-linux64/chrome',
  args: ['--no-sandbox'],
});
await mkdir(OUT_DIR, { recursive: true });
try {
  for (const [name, width, mode] of [
    ['phone-320', 320, 'agent'],
    ['phone-366', 366, 'agent'],
    ['phone-390', 390, 'agent'],
    ['phone-366-plan', 366, 'plan'],
    ['phone-320-plan', 320, 'plan'],
    ['tablet-700', 700, 'agent'],
    ['desktop-1200', 1200, 'agent'],
  ]) {
    const page = await browser.newPage({ viewport: { width: 480, height: 820 }, deviceScaleFactor: 2 });
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e.message || e)));
    await page.goto(
      `http://127.0.0.1:${PORT}/probe/composer-row.html?w=${width}&lang=zh-CN&mode=${mode}`,
      { waitUntil: 'networkidle', timeout: 60000 },
    );
    await page.locator('.pd-composer-control-row').waitFor({ state: 'visible', timeout: 30000 });
    const layout = await page.evaluate(measure);

    // The agent dropdown must open on a phone width and stay inside the viewport.
    const menu = { opened: false, items: [], insideViewport: false };
    const trigger = page.locator('.pd-composer-agent-control button').first();
    if (await trigger.count()) {
      await trigger.click({ timeout: 4000 }).catch((e) => errors.push(`agent-click: ${e.message.split('\n')[0]}`));
      const menuLocator = page.locator('[role="menu"][aria-label]').first();
      await menuLocator.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
      const visible = await menuLocator.count();
      if (visible) {
        const box = await menuLocator.boundingBox();
        const items = await menuLocator.locator('[role="menuitemradio"]').allTextContents();
        menu.opened = true;
        menu.items = items.map((t) => t.trim().replace(/\s+/g, ' '));
        menu.insideViewport = !!box && box.x >= 0 && box.y >= 0 && box.x + box.width <= 480 && box.y + box.height <= 820;
        await page.screenshot({ path: path.join(OUT_DIR, `composer-${name}-menu.png`) });
        await page.keyboard.press('Escape');
      }
    }

    await page.screenshot({ path: path.join(OUT_DIR, `composer-${name}.png`) });
    results.push({ name, width, ...layout, menu, errors });
    await page.close();
  }
} finally {
  await browser.close();
  await server.close();
}

await writeFile(path.join(OUT_DIR, 'composer-row.json'), JSON.stringify(results, null, 2));
for (const r of results) {
  const parts = (r.controls || []).map((c) => `${c.label || c.text}[${c.width}px]`);
  const geo = (r.dropdowns || [])
    .map(
      (d) =>
        `${d.name}{wrap ${d.wrapper.left}-${d.wrapper.right} trig ${d.trigger ? `${d.trigger.left}-${d.trigger.right}` : 'n/a'} label "${d.labelText}" kids ${d.kids
          .map((k) => `${k.tag}"${k.text}"${k.truncated ? `(${k.scrollWidth}>${k.width})` : ''}@${k.left}-${k.right}`)
          .join(',')}}`,
    )
    .join(' ');
  console.log(
    `${r.name} (box ${r.width}px): rows=${r.rows} free=${r.free}px overlaps=${(r.overlaps || []).join(',') || 'none'} spill=${r.spill} overflow=${r.rowOverflow || r.containerOverflow} menu=${r.menu.opened ? r.menu.items.join('|') : 'n/a'} :: ${parts.join(' ')} :: ${geo}`,
  );
}
console.log(JSON.stringify(results, null, 2));

const broken = results.filter(
  (r) =>
    r.error ||
    r.rows > 1 ||
    r.rowOverflow ||
    r.containerOverflow ||
    (r.overlaps || []).length ||
    r.spill ||
    r.errors.length ||
    (r.menu.opened && !r.menu.insideViewport),
);
if (broken.length) {
  console.error(`\nFAIL: ${broken.map((b) => b.name).join(', ')}`);
  process.exitCode = 1;
} else {
  console.log('\nOK: composer bottom bar stays on one line at every probed width.');
}
