// 对话/成果切换状态验收：反复切换后，激活态底色、文字色与图标色
// 必须仍然和另一侧明显不同；亮色暗色各测一轮。
import { createRequire } from 'node:module';
const require = createRequire('/home/Marc/PilotDeck-src/node_modules/.pnpm/playwright@1.60.0/node_modules/playwright/package.json');
const { chromium } = require('playwright');

const base = process.env.BASE_URL || 'http://127.0.0.1:5186/';
const out = { base, themes: {}, errors: [] };
const browser = await chromium.launch({
  headless: true,
  executablePath: '/home/Marc/.cache/ms-playwright/chromium-1237/chrome-linux64/chrome',
  args: ['--no-sandbox'],
});

const readButtons = () => {
  const nav = document.querySelector('nav[aria-label="对话与成果切换"]');
  if (!nav) return null;
  const buttons = [...nav.querySelectorAll('button')];
  const pick = (node) => {
    const cs = getComputedStyle(node);
    const svg = node.querySelector('svg');
    return {
      pressed: node.getAttribute('aria-pressed'),
      state: node.getAttribute('data-pane-state'),
      bg: cs.backgroundColor,
      color: cs.color,
      icon: svg ? getComputedStyle(svg).color : null,
      iconWidth: svg ? getComputedStyle(svg).strokeWidth : null,
      label: node.textContent.trim(),
    };
  };
  return { chat: pick(buttons[0]), artifacts: pick(buttons[1]) };
};

try {
  const context = await browser.newContext({ colorScheme: 'light' });
  const page = await context.newPage();
  page.on('pageerror', e => out.errors.push(e.message));
  await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(4000);

  // 连续切 6 次，采集中间与结束状态
  const states = [];
  for (let i = 0; i < 6; i += 1) {
    await page.getByRole('button', { name: '成果', exact: true }).click();
    await page.waitForTimeout(400);
    states.push(await page.evaluate(readButtons));
    await page.getByRole('button', { name: '对话', exact: true }).click();
    await page.waitForTimeout(400);
    states.push(await page.evaluate(readButtons));
  }
  out.themes.light = { first: states[0], afterSixToggles: states[states.length - 1] };
  out.themes.light.distinctInEveryState = states.every(
    s => s.chat.bg !== s.artifacts.bg && s.chat.color !== s.artifacts.color,
  );

  await page.emulateMedia({ colorScheme: 'dark' });
  await page.waitForTimeout(600);
  await page.getByRole('button', { name: '成果', exact: true }).click();
  await page.waitForTimeout(600);
  const darkArtifacts = await page.evaluate(readButtons);
  await page.getByRole('button', { name: '对话', exact: true }).click();
  await page.waitForTimeout(600);
  const darkChat = await page.evaluate(readButtons);
  out.themes.dark = { chat: darkChat, artifacts: darkArtifacts };
  out.themes.dark.distinct = darkChat.chat.bg !== darkChat.artifacts.bg && darkArtifacts.chat.bg !== darkArtifacts.artifacts.bg;

  await page.getByRole('button', { name: '成果', exact: true }).click();
  await page.waitForTimeout(1200);
  await page.screenshot({ path: 'pilotdeck-mobile/review/official/toggle-artifacts-dark.png' });
  await page.getByRole('button', { name: '对话', exact: true }).click();
  await page.waitForTimeout(1200);
  await page.screenshot({ path: 'pilotdeck-mobile/review/official/toggle-chat-dark.png' });
} finally {
  await browser.close();
}

console.log(JSON.stringify(out, null, 2).slice(0, 2600));