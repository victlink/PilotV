import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
const require = createRequire('/home/Marc/PilotDeck-src/node_modules/.pnpm/playwright@1.60.0/node_modules/playwright/package.json');
const { chromium } = require('playwright');
const browser = await chromium.launch({headless:true,executablePath:'/home/Marc/.cache/ms-playwright/chromium-1237/chrome-linux64/chrome',args:['--no-sandbox']});
const results=[];
await mkdir('pilotdeck-mobile/review/official',{recursive:true});
try {
 for (const [name,width,height] of [['phone',390,844],['landscape',844,390],['tablet',768,1024],['tablet-wide',1024,768],['desktop',1440,900]]) {
  const page=await browser.newPage({viewport:{width,height}}); const errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.goto('http://127.0.0.1:5186/',{waitUntil:'networkidle',timeout:60000});
  await page.locator('button:visible').first().waitFor({state:'visible',timeout:60000});
  const state=await page.evaluate(()=>({overflow:document.documentElement.scrollWidth>innerWidth,title:document.title,buttons:document.querySelectorAll('button').length,body:document.body.innerText.slice(0,180)}));
  await page.screenshot({path:`pilotdeck-mobile/review/official/${name}.png`});
  results.push({name,width,height,...state,errors}); await page.close();
 }
} finally {await browser.close();}
await writeFile('pilotdeck-mobile/review/official/result.json',JSON.stringify(results,null,2));
console.log(JSON.stringify(results,null,2));
if(results.some(r=>r.overflow||r.errors.length))process.exitCode=1;
