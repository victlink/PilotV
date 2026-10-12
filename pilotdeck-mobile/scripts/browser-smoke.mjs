import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
const require = createRequire('/home/Marc/PilotDeck-src/node_modules/.pnpm/playwright@1.60.0/node_modules/playwright/package.json');
const { chromium } = require('playwright');
const base = 'http://127.0.0.1:5186/';
const review = 'pilotdeck-mobile/review';
await mkdir(review, { recursive: true });
const browser = await chromium.launch({ headless: true, executablePath: '/home/Marc/.cache/ms-playwright/chromium-1237/chrome-linux64/chrome', args: ['--no-sandbox'] });
const context = await browser.newContext({ viewport: {width:390,height:844}, deviceScaleFactor:1 });
const page = await context.newPage();
const errors = [], failures = [], results = [];
page.on('pageerror', e => errors.push(e.message));
page.on('console', m => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
page.on('requestfailed', r => failures.push(`${r.method()} ${r.url()} ${r.failure()?.errorText}`));
async function check(label, fn) { try { const value = await fn(); results.push({label, pass:true, ...value}); } catch(e) { results.push({label, pass:false, error:String(e)}); } }
async function metrics() { return page.evaluate(() => {const d=document.documentElement, app=document.querySelector('.app'), main=document.querySelector('.main'), modal=document.querySelector('.modal'); const box=x=> x && ({left:Math.round(x.getBoundingClientRect().left),right:Math.round(x.getBoundingClientRect().right),top:Math.round(x.getBoundingClientRect().top),bottom:Math.round(x.getBoundingClientRect().bottom),scrollWidth:x.scrollWidth,clientWidth:x.clientWidth,scrollHeight:x.scrollHeight,clientHeight:x.clientHeight}); return {viewport:[innerWidth,innerHeight],document:box(d),app:box(app),main:box(main),modal:box(modal),horizontalOverflow:d.scrollWidth>innerWidth,verticalOverflow:d.scrollHeight>innerHeight};}); }
async function screenshot(name) { await page.screenshot({path:`${review}/${name}.png`, timeout:15000}); return `${review}/${name}.png`; }
try {
  await page.goto(base, {waitUntil:'domcontentloaded'});
  await page.getByRole('heading',{name:'选择会话'}).waitFor();
  for(const [label,width,height] of [['phone-portrait',390,844],['phone-landscape',844,390],['tablet-portrait',768,1024],['tablet-landscape',1024,768],['desktop',1440,900]]) {
    await check(label,async()=> { await page.setViewportSize({width,height}); await page.waitForTimeout(180); const measure=await metrics(); const image=await screenshot(label); if(measure.horizontalOverflow) throw Error(`horizontal overflow ${JSON.stringify(measure)}`); if(label==='phone-landscape'){const layout=await page.evaluate(()=>{const feed=document.querySelector('.feed'),empty=document.querySelector('.empty'),composer=document.querySelector('.composer'),tabs=document.querySelector('.tabs');const rect=e=>{const r=e.getBoundingClientRect();return {top:r.top,bottom:r.bottom,height:r.height}};return {feed:rect(feed),empty:rect(empty),composer:rect(composer),tabsScrollable:tabs.scrollWidth>tabs.clientWidth,tabCount:tabs.querySelectorAll('button').length,feedScrollable:feed.scrollHeight>feed.clientHeight}});if(layout.feed.bottom>layout.composer.top+1||layout.composer.bottom>height+1||layout.empty.height<100||!layout.feedScrollable||!layout.tabsScrollable)throw Error(`landscape collision ${JSON.stringify(layout)}`);return {measure,layout,image};} return {measure,image}; });
  }
  await page.setViewportSize({width:390,height:844});
  await check('scrollable modules and panel layouts',async()=>{const states=[];for(const [tab,selector] of [['工作空间','.native-panel'],['MCP','section[aria-label="MCP panel"]']]){await page.getByRole('navigation',{name:'功能模块'}).getByRole('button',{name:tab}).click();await page.locator(selector).waitFor();const layout=await page.evaluate(selector=>{const panel=document.querySelector(selector),tabs=document.querySelector('.tabs'),r=panel.getBoundingClientRect();return {panelBottom:r.bottom,panelScrollHeight:panel.scrollHeight,panelClientHeight:panel.clientHeight,tabScrollWidth:tabs.scrollWidth,tabClientWidth:tabs.clientWidth,buttons:[...panel.querySelectorAll('button')].map(b=>Math.round(b.getBoundingClientRect().height))}},selector);if(layout.panelBottom>845||layout.buttons.some(h=>h<44)||layout.tabScrollWidth<=layout.tabClientWidth)throw Error(`${tab} layout ${JSON.stringify(layout)}`);states.push({tab,layout,image:await screenshot(`phone-${tab==='MCP'?'mcp':'native'}-panel`)});}await page.getByRole('navigation',{name:'功能模块'}).getByRole('button',{name:'会话'}).click();return {states};});
  await check('add form open and scroll',async()=> {await page.getByRole('button',{name:'打开导航'}).click(); await page.getByRole('button',{name:'＋ 新建'}).click(); const dialog=page.getByRole('dialog',{name:'实例配置'}); await dialog.getByRole('heading',{name:'添加实例'}).waitFor(); const image=await screenshot('phone-add-form'); return {measure:await metrics(),image};});
  const dialog=page.getByRole('dialog',{name:'实例配置'});
  await check('invalid form validation',async()=> {await dialog.getByRole('button',{name:'保存实例'}).click(); await page.getByRole('alert').getByText('请填写实例名称').waitFor(); return {alert:await page.getByRole('alert').innerText()};});
  await check('save dummy config',async()=> {await dialog.getByLabel('实例名称').fill('Smoke dummy'); await dialog.getByLabel('REST 地址').fill('http://127.0.0.1:65534'); await dialog.getByLabel('WebSocket 地址').fill('ws://127.0.0.1:65534'); await dialog.getByLabel('MCP 地址').fill('http://127.0.0.1:65534/mcp'); await dialog.getByLabel('备注').fill('Browser smoke test only'); await dialog.getByRole('button',{name:'保存实例'}).click(); await dialog.waitFor({state:'hidden'}); const configs=await page.evaluate(()=>JSON.parse(localStorage.getItem('pilotdeck-mobile.instances.v1')||'[]')); if(configs.length!==1||configs[0].token!=='') throw Error(`unexpected stored config ${JSON.stringify(configs)}`); return {saved:{name:configs[0].name,rest:configs[0].rest,ws:configs[0].ws,tokenLength:configs[0].token.length}, image:await screenshot('phone-saved-dummy')};});
  await check('edit form and persist',async()=> {await page.getByRole('button',{name:'打开导航'}).click(); await page.getByRole('button',{name:'编辑配置'}).click(); await dialog.getByRole('heading',{name:'编辑实例'}).waitFor(); const formImage=await screenshot('phone-edit-form'); await dialog.getByLabel('实例名称').fill('Smoke dummy edited'); await dialog.getByLabel('备注').fill('Edited smoke test'); await dialog.getByRole('button',{name:'保存实例'}).click(); await page.reload({waitUntil:'domcontentloaded'}); await page.locator('.eyebrow').getByText('Smoke dummy edited', {exact:false}).waitFor(); const configs=await page.evaluate(()=>JSON.parse(localStorage.getItem('pilotdeck-mobile.instances.v1')||'[]')); if(configs.length!==1||configs[0].name!=='Smoke dummy edited'||configs[0].notes!=='Edited smoke test')throw Error('edit did not persist'); return {formImage,persisted:true,image:await screenshot('phone-edited-reloaded')};});
  await check('REST login clears busy and conceals token', async () => {
    await page.route('http://127.0.0.1:65534/api/auth/login', route => route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ token: 'fixture-jwt-not-real' }) }));
    await page.getByRole('navigation', {name:'功能模块'}).getByRole('button', {name:'工作空间'}).click();
    await page.getByRole('button', {name:'官方 UI REST（独立鉴权）'}).click();
    const panel = page.getByRole('region', {name:'UI REST panel'});
    await panel.getByLabel('Username', {exact:true}).fill('fixture');
    await panel.getByLabel('Password (memory only)', {exact:true}).fill('fixture-password');
    await panel.getByRole('button', {name:'Login to UI server'}).click();
    await panel.getByText('Authenticated', {exact:true}).waitFor();
    if(await panel.getByRole('button', {name:'Run REST operation'}).count()) {
      if(await panel.getByRole('button', {name:'Run REST operation'}).isDisabled()) throw Error('login left busy');
    }
    if((await panel.innerText()).includes('fixture-jwt-not-real')) throw Error('JWT leaked into output');
    if(await panel.getByLabel('Password (memory only)', {exact:true}).inputValue()) throw Error('password retained');
    await panel.getByLabel('Password (memory only)', {exact:true}).fill('second');
    if(await panel.getByRole('button', {name:'Login to UI server'}).isDisabled()) throw Error('login remains busy');
    return {loginCompleted:true, tokenHidden:true};
  });
  await check('saved config across viewports',async()=> {let states=[]; for(const [label,width,height] of [['phone-landscape',844,390],['tablet-portrait',768,1024],['tablet-landscape',1024,768],['desktop',1440,900]]) {await page.setViewportSize({width,height}); await page.waitForTimeout(120); const measure=await metrics(); const image=await screenshot(`${label}-saved`); states.push({label,measure,image}); if(measure.horizontalOverflow)throw Error(`${label} horizontal overflow`);} return {states};});
} finally {console.log(JSON.stringify({results,errors,failures},null,2)); await browser.close();}
if(results.some(x=>!x.pass))process.exitCode=1;
