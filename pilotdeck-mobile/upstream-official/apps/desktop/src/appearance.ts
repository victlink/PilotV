import { startupLabels, startupVisualProgress } from './startupPresentation';
import { startupStyle } from './startupStyle';
import { LEGACY_LIGHT_PRESETS, LIGHT_PRESETS, normalizeLightAppearance, deriveLightColors, type LightAppearance } from './lightAppearance';
import { normalizeInterfacePreferences, type InterfacePreferences } from './interfacePreferences';
export type DesktopAppearance = { language: 'en' | 'zh-CN'; themeMode: 'light' | 'dark' | 'system'; lightAppearance?: LightAppearance; interfacePreferences?: InterfacePreferences };

export function normalizeAppearance(value: unknown, locale = 'en'): DesktopAppearance {
  const record = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  return {
    language: record.language === 'en' || record.language === 'zh-CN' ? record.language : locale.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en',
    themeMode: record.themeMode === 'light' || record.themeMode === 'dark' ? record.themeMode : 'system',
    ...(record.lightAppearance !== undefined ? { lightAppearance: normalizeLightAppearance(record.lightAppearance) } : {}),
    ...(record.interfacePreferences !== undefined ? { interfacePreferences: normalizeInterfacePreferences(record.interfacePreferences) } : {}),
  };
}

const STARTUP_ZH: Record<string, string> = {
  "Preparing PilotV runtime...": "正在准备 PilotV 运行环境…",
  "Checking local configuration...": "正在检查本地配置…",
  "Starting Web UI server...": "正在启动网页服务…",
  "PilotV is ready for model setup.": "PilotV 已就绪，请配置模型。",
  "PilotV runtime stopped.": "PilotV 运行环境已停止。",
  "Gateway exited unexpectedly. The Web UI is still available.": "Gateway 意外退出，网页界面仍可使用。",
  "Model configuration needs attention.": "模型配置需要修复。",
  "Starting local gateway...": "正在启动本地 Gateway…",
  "PilotV is ready.": "PilotV 已就绪。",
  "Gateway failed to start. The Web UI is still available.": "Gateway 启动失败，网页界面仍可使用。",
  "server exited unexpectedly. See runtime log for details.": "网页服务意外退出，请查看运行日志。",
  "gateway exited unexpectedly. See runtime log for details.": "Gateway 意外退出，请查看运行日志。",
  "PilotV failed to start.": "PilotV 启动失败。",
  "PilotV failed to restore window.": "PilotV 无法恢复窗口。",
  "Retry": "重试",
  "Open Log": "打开日志",
  "Starting PilotV...": "正在启动 PilotV…",
  "Log: ": "日志：",
  "Unknown startup error.": "未知的启动错误。",
  "PilotV could not stop": "PilotV 无法停止"
};

export function startupText(message: string, language: DesktopAppearance['language']): string {
  // 上游旧消息偶尔还带着旧品牌名，先归一成 PilotV 再查中文表。
  const branded = message.replace(/PilotDeck/g, 'PilotV');
  return language === 'zh-CN' ? STARTUP_ZH[branded] ?? branded : branded;
}

// 首屏静态壳（原生启动页与 Web 首帧）必须和 React 接管后的 StartupFrame 画同一个橙 V 字标。
// 这里原本是「深色方块徽标 + 纯文本 PilotV」，React 一接管就换成字标，中间会明显闪一下旧品牌。
// 字形是品牌定稿数据，从 ui/src/components/app-shell/PilotVLogo.tsx 机械搬运，改字标要两边一起改；
// ui/src/components/auth/view/StartupPresentation.spec.tsx 会逐条比对两边的 path d，漏改会直接报错。
const STARTUP_LOGO_HEIGHT = 44;
const STARTUP_LOGO_WIDTH = (STARTUP_LOGO_HEIGHT * 275) / 98;
const STARTUP_LOGO_GLYPHS: ReadonlyArray<readonly [number, string]> = [
  [8, 'M655 742Q787 742 845.0 805.0Q903 868 903 981Q903 1031 888.0 1072.0Q873 1113 842.5 1142.5Q812 1172 765.5 1188.0Q719 1204 655 1204H479V742ZM655 1457Q809 1457 919.5 1420.5Q1030 1384 1101.5 1320.0Q1173 1256 1207.0 1169.0Q1241 1082 1241 981Q1241 872 1206.0 781.0Q1171 690 1099.0 625.0Q1027 560 916.5 523.5Q806 487 655 487H479V0H141V1457Z'],
  [67.6, 'M422 1037V0H112V1037ZM454 1321Q454 1284 439.0 1251.5Q424 1219 398.0 1194.5Q372 1170 337.5 1155.5Q303 1141 264 1141Q226 1141 193.0 1155.5Q160 1170 134.5 1194.5Q109 1219 94.5 1251.5Q80 1284 80 1321Q80 1359 94.5 1392.0Q109 1425 134.5 1450.0Q160 1475 193.0 1489.0Q226 1503 264 1503Q303 1503 337.5 1489.0Q372 1475 398.0 1450.0Q424 1425 439.0 1392.0Q454 1359 454 1321Z'],
  [90.3, 'M415 1497V0H105V1497Z'],
  [112.3, 'M583 1053Q701 1053 798.0 1016.0Q895 979 964.5 910.0Q1034 841 1072.5 742.5Q1111 644 1111 521Q1111 397 1072.5 297.5Q1034 198 964.5 128.5Q895 59 798.0 21.5Q701 -16 583 -16Q464 -16 366.5 21.5Q269 59 198.5 128.5Q128 198 89.5 297.5Q51 397 51 521Q51 644 89.5 742.5Q128 841 198.5 910.0Q269 979 366.5 1016.0Q464 1053 583 1053ZM583 214Q690 214 740.5 289.5Q791 365 791 519Q791 673 740.5 748.0Q690 823 583 823Q473 823 422.0 748.0Q371 673 371 519Q371 365 422.0 289.5Q473 214 583 214Z'],
  [166.4, 'M476 -16Q402 -16 345.5 5.5Q289 27 250.5 66.5Q212 106 192.0 162.0Q172 218 172 287V823H84Q60 823 43.0 838.5Q26 854 26 884V1005L191 1037L252 1290Q264 1338 320 1338H482V1035H739V823H482V308Q482 272 499.5 248.5Q517 225 550 225Q567 225 578.5 228.5Q590 232 598.5 236.5Q607 241 614.5 244.5Q622 248 632 248Q646 248 654.5 241.5Q663 235 672 221L766 74Q706 29 631.0 6.5Q556 -16 476 -16Z'],
];
const STARTUP_LOGO_V = { x: 200.8, d: 'M1448 1457 864 0H558L-26 1457H246Q290 1457 317.0 1436.5Q344 1416 358 1384L640 604Q660 553 679.0 492.5Q698 432 715 366Q729 432 746.5 492.5Q764 553 784 604L1064 1384Q1075 1412 1103.5 1434.5Q1132 1457 1174 1457Z' };
const STARTUP_LOGO_LINE = { x: 200.7, y: 91.85, w: 71.3, h: 5.5, rx: 2.75 };

function startupLogoSvg(): string {
  const glyph = ([x, d]: readonly [number, string]) =>
    `<g transform="translate(${x.toFixed(2)} 80.85) scale(0.050 -0.050)"><path d="${d}"/></g>`;
  const line = STARTUP_LOGO_LINE;
  return `<svg class="pv-logo" viewBox="4 3 275 98" width="${STARTUP_LOGO_WIDTH}" height="${STARTUP_LOGO_HEIGHT}" preserveAspectRatio="xMinYMid meet" role="img" aria-label="PilotV" fill="currentColor">`
    + `${STARTUP_LOGO_GLYPHS.map(glyph).join('')}`
    + `<g transform="translate(${STARTUP_LOGO_V.x.toFixed(2)} 80.85) scale(0.050 -0.050)"><path d="${STARTUP_LOGO_V.d}" fill="#e55a09" stroke="#e55a09" stroke-width="32" paint-order="stroke"/></g>`
    + `<rect x="${line.x}" y="${line.y}" width="${line.w}" height="${line.h}" rx="${line.rx}" fill="#297cc0"/>`
    + '</svg>';
}

export function renderLoadingHtml(appearance: DesktopAppearance, web = false): string {
  // startupLabels 已经是 PilotV 定稿文案，不需要再做品牌替换。
  const brandLabels = (language: DesktopAppearance['language']) => startupLabels(language);
  const labels = brandLabels(appearance.language);
  const light = normalizeLightAppearance(appearance.lightAppearance);
  const canvas = light.preset === 'default' ? '#ffffff' : deriveLightColors(light).background;
  return `<!doctype html><html lang="${appearance.language}" data-theme="${appearance.themeMode}">
<head><meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/><title>PilotV</title>
<style>
:root{color-scheme:light;--startup-bg:${canvas};--startup-fg:#171717;--startup-muted:#525252;--startup-line:#e5e5e5}
:root[data-theme="dark"]{color-scheme:dark;--startup-bg:#0a0a0a;--startup-fg:#f5f5f5;--startup-muted:#a3a3a3;--startup-line:#303039}
@media(prefers-color-scheme:dark){:root[data-theme="system"]{color-scheme:dark;--startup-bg:#0a0a0a;--startup-fg:#f5f5f5;--startup-muted:#a3a3a3;--startup-line:#303039}}
${startupStyle}
.pd-startup-brand{display:flex;align-items:center;justify-content:center;gap:12px}
#failure{display:none}#startup[data-error=true] #loading{display:none}#startup[data-error=true] #failure{display:block}#saveStatus:empty{display:none}
</style></head><body style="margin:0"><div class="pd-startup-screen" id="startup"><main><h1 class="pd-startup-brand" aria-label="PilotV">${startupLogoSvg()}</h1>
<div id="loading" role="status"><div class="pd-startup-track" role="progressbar" aria-label="PilotV" aria-valuemin="0" aria-valuemax="100" aria-valuenow="8"><div class="pd-startup-bar" id="bar" style="width:8%"></div></div><p class="pd-startup-message" id="message">${labels.starting}</p></div>
<section class="pd-startup-failure" id="failure" role="alert"><h2>${labels.failed}</h2><p class="reason" id="reason"></p><div class="pd-startup-meta" id="code"></div><p class="pd-startup-meta" id="log"></p><div class="pd-startup-actions"><button id="retry">${labels.restart}</button><button id="saveLog" class="secondary">${labels.save}</button></div><p class="pd-startup-meta" id="saveStatus" role="status"></p></section>
</main></div><script>(()=>{
const web=${web};
const languages=${JSON.stringify({ en: brandLabels('en'), 'zh-CN': brandLabels('zh-CN') })};
const saved=key=>{try{return localStorage.getItem(key)}catch{return null}};
const appearance=web?(window.pilotdeckDesktop?.getAppearance?.()||{language:saved('userLanguage')||(navigator.language.startsWith('zh')?'zh-CN':'en'),themeMode:saved('themeMode')||saved('theme')||'system'}):${JSON.stringify({ language: appearance.language, themeMode: appearance.themeMode })};
let labels=languages[appearance.language]||languages.en;
if(web){
 document.documentElement.dataset.theme=appearance.themeMode;
 // Keep the startup canvas aligned with PilotV's first-paint theme.
 let preference=appearance.lightAppearance;try{preference??=JSON.parse(saved('pilotdeck-light-appearance-v1')||'null')}catch{}
 const presets=${JSON.stringify({ ...LIGHT_PRESETS, ...LEGACY_LIGHT_PRESETS })};
 const background=preference?.preset==='custom'?preference.custom?.background:preference?.preset!=='default'?presets[preference?.preset]?.background:null;
 const dark=appearance.themeMode==='dark'||appearance.themeMode==='system'&&window.matchMedia?.('(prefers-color-scheme: dark)').matches;
 document.documentElement.style.setProperty('--startup-bg',dark?'#0a0a0a':/^#[0-9a-f]{6}$/i.test(background)?background:'#ffffff');
}
const root=document.getElementById('startup'),bar=document.getElementById('bar'),message=document.getElementById('message');
const visualProgress=${startupVisualProgress.toString()};
let current={phase:'starting',progress:8,startedAt:Date.now(),phaseStartedAt:Date.now()};
let animationStart=0;
function draw(){bar.style.width=visualProgress(current)+'%';bar.parentElement.setAttribute('aria-valuenow',String(current.progress||8))}
function update(status){
 if(!status)return;
 const reset=status.phase==='starting'&&current.phase!=='starting';
 const finishing=current.completed&&!reset&&status.phase!=='error'&&status.phase!=='stopped';
 current={...status,completed:!!(status.completed||finishing),leaving:!!(status.leaving||finishing&&current.leaving),progress:reset?8:Math.max(current.progress||8,status.progress||8),startedAt:status.startedAt||(reset?Date.now():current.startedAt),phaseStartedAt:status.phaseStartedAt||(status.phase===current.phase?current.phaseStartedAt:Date.now())};
 if(status.language)labels=languages[status.language]||languages.en;
 if(animationStart!==current.startedAt){animationStart=current.startedAt;root.style.setProperty('--startup-animation-offset',-(Date.now()-animationStart)+'ms')}
 window.__pilotdeckStartupState=current;root.dataset.error=String(status.phase==='error');root.dataset.complete=String(current.completed);root.dataset.leaving=String(current.leaving);draw();
 if(status.phase==='error'){
  const code=(status.error||'').match(/\\bPD_[A-Z_]+\\b/)?.[0]||'PD_RUNTIME_PROCESS_FAILED';
  document.getElementById('reason').textContent=labels[code]||labels.unknown;
  document.getElementById('code').textContent=code;
  document.getElementById('log').textContent=status.logPath?labels.log+': '+status.logPath:'';
 }else message.textContent=labels[status.phase]||labels.starting;
}
message.textContent=labels.starting;document.querySelector('#failure h2').textContent=labels.failed;document.getElementById('retry').textContent=labels.restart;document.getElementById('saveLog').textContent=labels.save;
// Seed the real position before enabling transitions. A new document must not
// animate from the template's 8% after the native loading page nearly finished.
bar.style.transition='none';
const unsubscribe=window.pilotdeckDesktop?.onRuntimeStatus(update);update(window.pilotdeckDesktop?.getRuntimeStatus?.()||current);
bar.getBoundingClientRect();bar.style.transition='';
const timer=setInterval(draw,400);window.__pilotdeckStartupCleanup=()=>{clearInterval(timer);unsubscribe?.()};window.__pilotdeckStartupUpdate=update;
document.getElementById('retry').addEventListener('click',()=>window.pilotdeckDesktop?.retryRuntime?window.pilotdeckDesktop.retryRuntime():window.location.reload());
document.getElementById('saveLog').addEventListener('click',async()=>{
 const button=document.getElementById('saveLog'),status=document.getElementById('saveStatus');button.disabled=true;status.textContent='';
 try{
  if(window.pilotdeckDesktop?.saveRuntimeLogs){const result=await window.pilotdeckDesktop.saveRuntimeLogs();if(!result.canceled)status.textContent=labels.saved}
  else{const response=await fetch('/api/diagnostics/logs');if(!response.ok)throw Error('Download failed');const url=URL.createObjectURL(await response.blob()),a=document.createElement('a');a.href=url;a.download='PilotV-runtime.log';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000)}
 }catch{status.textContent=labels.saveFailed}finally{button.disabled=false}
});
})();</script></body></html>`;
}
