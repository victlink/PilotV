// pilotv verify --live —— 真开一个浏览器把关键路径走一遍，并留下截图当证据。
//
// 为什么值得自己写：这个仓库里 verify_*.py / verify_*.mjs 有三十多个，全部是
// 「REST 通不通」级别的检查。而 2026-11-05 那个「登录后又回登录页」的缺陷，
// REST 全绿、页面全坏 —— 只有真浏览器能看见。参考 Rodex 的 browser_check：
// 断言 + 截图 + 明确区分「服务器没起」和「连接被拒」两种失败。
//
// 凭据只从环境变量读，绝不写进仓库、绝不打进日志。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { closeBrowser, launchBrowser, openPage } from './cdp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const DEFAULT_BASE = process.env.PILOTV_BASE || 'https://127.0.0.1:5186';

/**
 * @param {{base?:string, out?:string, cdpPort?:number, keepOpen?:boolean, json?:boolean}} options
 */
export async function verifyLive(options = {}) {
  const base = options.base || DEFAULT_BASE;
  const outDir = options.out ? path.resolve(options.out) : path.join(ROOT, 'review');
  const port = Number(options.cdpPort || 9333);
  const user = process.env.PILOTV_VERIFY_USER || '';
  const password = process.env.PILOTV_VERIFY_PASSWORD || '';
  const steps = [];
  const artifacts = [];
  let browser = null;
  let cdp = null;

  const record = (name, ok, detail, extra = {}) => {
    steps.push({ name, ok, detail: String(detail).slice(0, 400), ...extra });
    return ok;
  };

  try {
    // 先用 REST 探一次：把「服务根本没起」和「页面有问题」分开报。
    // 这两件事的处理方式完全不同，混成一条「verify 失败」等于没说。
    const { probeHttp } = await import('./probes.mjs');
    const reach = await probeHttp(`${base}/`, { timeoutMs: 5000 });
    if (!reach.status) {
      const code = reach.error?.code || 'UNKNOWN';
      const hint = code === 'ECONNREFUSED'
        ? `${base} 没人监听：服务没起。先用启动器拉起四服务，再跑 verify。`
        : code === 'ETIMEDOUT'
          ? `${base} 超时：设备多半不在 Tailscale 网里，先 tailscale status。`
          : `${base} 连不上（${code}）。`;
      record('服务可达', false, hint);
      return finish({ ok: false, base, steps, screenshots: artifacts, summary: summarize(steps, artifacts), fatal: 'unreachable' });
    }
    record('服务可达', true, `HTTP ${reach.status}`);

    browser = await launchBrowser({ port, headless: !options.headed });
    const page = await openPage(port, `${base}/`);
    cdp = page.cdp;
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    try { await cdp.send('Network.enable'); } catch { /* 拿不到网络事件不影响主流程 */ }

    const consoleErrors = [];
    const failedRequests = [];
    cdp.on('Runtime.exceptionThrown', (params) => {
      consoleErrors.push(params.exceptionDetails?.exception?.description
        || params.exceptionDetails?.text || 'unknown exception');
    });
    cdp.on('Network.responseReceived', (params) => {
      if (params.response.status >= 400) failedRequests.push(`${params.response.status} ${params.response.url}`);
    });

    const evaluate = async (expression) => {
      const result = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || 'page eval failed');
      return result.result?.value;
    };
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const shoot = async (name) => {
      const file = path.join(outDir, `verify-live-${name}.png`);
      fs.mkdirSync(outDir, { recursive: true });
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
      artifacts.push(path.relative(ROOT, file).split(path.sep).join('/'));
      return file;
    };

    await waitFor(() => evaluate('document.readyState === "complete"'), 15000, '页面加载完成');
    await wait(2500);

    const onLoginPage = async () => Boolean(await evaluate('!!document.querySelector("input[name=password]")'));
    const hasToken = async () => Boolean(await evaluate('!!localStorage.getItem("pilotdeck-tokens")'));

    if (await onLoginPage()) {
      record('登录页出现', true, '需要登录（正常）');
      if (!user || !password) {
        // 明确说「缺凭据」而不是报一个页面断言失败：否则下一个人会去查页面。
        record('登录', false, '没有登录凭据，无法继续。', {
          fix: '设 PILOTV_VERIFY_USER / PILOTV_VERIFY_PASSWORD 再跑（凭据不进仓库、不进日志）',
        });
        await shoot('login-page');
        return finish({ ok: false, base, steps, screenshots: artifacts, summary: summarize(steps, artifacts), fatal: 'no-credentials' });
      }
      // 直接塞 value 会被 React 忽略（它自己持有 state），必须走原生 setter + input 事件。
      const filled = await evaluate(`(() => {
        const set = (el, value) => {
          Object.getOwnPropertyDescriptor(el.constructor.prototype, 'value').set.call(el, value);
          el.dispatchEvent(new Event('input', { bubbles: true }));
        };
        const u = document.querySelector('input[name=username]');
        const p = document.querySelector('input[name=password]');
        if (!u || !p) return 'missing-fields';
        set(u, ${JSON.stringify(user)});
        set(p, ${JSON.stringify(password)});
        document.querySelector('button[type=submit]').click();
        return 'submitted';
      })()`);
      record('提交登录', filled === 'submitted', filled);

      const loggedOut = await waitFor(async () => !(await onLoginPage()) && (await hasToken()), 20000, '登录后拿到会话并离开登录页');
      await shoot('after-login');
      record('登录成功', loggedOut.ok, loggedOut.ok
        ? `已跳转到 ${await evaluate('location.pathname')}`
        : `${loggedOut.reason}。登录页仍在，或 localStorage 里没有 pilotdeck-tokens。`, {
        fix: loggedOut.ok ? undefined : '看下面「>=400 的请求」；缺陷 B 那类「前端拿到 401 就清 token 刷新」就是这个形状',
      });
      if (!loggedOut.ok) {
        record('后续步骤', false, '因登录失败而跳过（不假装通过）');
        return finish({ ok: false, base, steps, screenshots: artifacts, summary: summarize(steps, artifacts), consoleErrors, failedRequests });
      }
      // 登录前那批并发请求拿到 401 是正常的（那时还没有 token），
      // 不清零就会把「未登录」误报成「登录后一直 401」——后者才是缺陷 B 的形状。
      failedRequests.length = 0;
    } else {
      record('登录页出现', true, (await hasToken()) ? '已带会话，跳过登录' : '不在登录页且没有 token');
    }

    // 设备切换器：这是网关这一层最容易被装坏的东西（清单没同步就整个消失）
    const deviceNames = await evaluate(`JSON.stringify(
      [...document.querySelectorAll('aside *, nav *, [data-pilotv-device]')]
        .map(e => (e.innerText || '').trim())
        .filter(t => t && t.length < 24)
    )`);
    const devices = JSON.parse(deviceNames || '[]');
    const switcherVisible = devices.some(name => /当前设备|增加设备/.test(name));
    record('设备切换器可见', switcherVisible, switcherVisible
      ? `看到 ${devices.filter(n => /当前设备|增加设备/.test(n)).length} 个入口`
      : `页面上找不到设备入口：${devices.slice(0, 6).join(' / ') || '（一个可点项都没有）'}`, {
      fix: switcherVisible ? undefined : '检查 ui/dist/devices.json 是否是好的那份（pilotv doctor 能查）',
    });

    // 成果台：走网关的转发路径，而不是直连 8799 —— 要验的就是转发这一层
    const artifactsProbe = await evaluate(`(async () => {
      try {
        const response = await fetch('/api/artifacts?limit=5');
        const text = await response.text();
        let parsed = null;
        try { parsed = JSON.parse(text); } catch { /* 下面按状态码判 */ }
        const items = Array.isArray(parsed) ? parsed : (parsed?.items || parsed?.artifacts || parsed?.data || []);
        return JSON.stringify({ status: response.status, type: response.headers.get('content-type') || '', count: Array.isArray(items) ? items.length : -1 });
      } catch (error) { return JSON.stringify({ error: String(error) }); }
    })()`);
    const artifactsInfo = JSON.parse(artifactsProbe || '{}');
    const artifactsOk = artifactsInfo.status === 200 && artifactsInfo.count >= 0;
    record('成果台（经网关转发）', artifactsOk, artifactsOk
      ? `HTTP 200，${artifactsInfo.count} 条成果`
      : `HTTP ${artifactsInfo.status ?? '-'} ${artifactsInfo.error || artifactsInfo.type || ''}`, {
      fix: artifactsOk ? undefined : '/api/artifacts 经 5186 转发到 8799；不通先查 8799 与 devices.json 的 artifactsPort',
    });

    // 会话可用性：这条长连接是前端的主链路，而它需要带 token。
    // token 的取法必须和前端一致：pilotdeck-tokens 是「按后端 origin 分开存」的表，
    // origin 从网关注入的 window.__PILOTV__.backend 拿（不能用 location.origin，
    // 那是前端自己的来源，不是后端的）。取错 key 会得到一个假失败。
    const wsProbe = await evaluate(`(async () => {
      const origin = (window.__PILOTV__ && window.__PILOTV__.backend) || '';
      let token = '';
      try { token = (JSON.parse(localStorage.getItem('pilotdeck-tokens') || '{}'))[origin] || ''; } catch {}
      const url = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws'
        + (token ? '?token=' + encodeURIComponent(token) : '');
      return await new Promise((resolve) => {
        let settled = false;
        const done = (value) => { if (!settled) { settled = true; try { socket.close(); } catch {} resolve(value); } };
        const socket = new WebSocket(url);
        socket.addEventListener('open', () => done('open'));
        socket.addEventListener('error', () => done(token ? 'error' : 'error-no-token'));
        setTimeout(() => done('timeout'), 8000);
      });
    })()`);
    record('会话 WebSocket 可达', wsProbe === 'open', `/ws -> ${wsProbe}`, {
      fix: wsProbe === 'open' ? undefined
        : wsProbe === 'error-no-token'
          ? '拿不到当前设备的登录令牌（pilotdeck-tokens / window.__PILOTV__.backend 对不上），前端同样连不上'
          : '/ws 由 5186 代理到后端的 /ws；不通先确认后端在、再确认隧道没被空闲阈值砍掉',
    });

    await shoot('final');
    const noisy = consoleErrors.filter(line => !/favicon|ResizeObserver/.test(line));
    record('页面无未捕获异常', noisy.length === 0, noisy.length
      ? noisy.slice(0, 3).map(line => line.split('\n')[0]).join(' | ')
      : '没有');

    // 401 单独拎出来：它在 PilotV 里是「清 token 弹回登录页」的触发器，
    // 混在「有一些 4xx」里就看不见了（缺陷 B 的现场）。
    const unauthorized = [...new Set(failedRequests.filter(line => line.startsWith('401')))];
    record('没有意外的 401', unauthorized.length === 0, unauthorized.length
      ? unauthorized.slice(0, 4).join(' | ') : '没有 401', {
      severity: unauthorized.length ? 'warn' : undefined,
    });

    return finish({ ok: steps.every(step => step.ok), base, steps, screenshots: artifacts, summary: summarize(steps, artifacts), consoleErrors: noisy, failedRequests: [...new Set(failedRequests)] });
  } catch (error) {
    // 浏览器起不来要说清是「没装」还是「起不来」：前者装一次就好，后者是环境冲突。
    record('执行中断', false, `${error.message}${error.hint ? ` — ${error.hint}` : ''}`);
    return finish({ ok: false, base, steps, screenshots: artifacts, summary: summarize(steps, artifacts), fatal: error.message });
  } finally {
    if (cdp) { try { cdp.close(); } catch { /* 已经断了 */ } }
    if (browser && !options.keepOpen) await closeBrowser(browser);
  }
}

async function waitFor(check, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let lastError = '';
  while (Date.now() < deadline) {
    try {
      if (await check()) return { ok: true };
    } catch (error) { lastError = error.message; }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  return { ok: false, reason: `等不到「${label}」（${timeoutMs}ms${lastError ? `，最后一次：${lastError}` : ''}）` };
}

function summarize(steps, screenshots) {
  const failed = steps.filter(step => !step.ok);
  const lines = steps.map(step => `${step.ok ? 'PASS' : 'FAIL'} ${step.name}  ${step.detail}`);
  if (screenshots.length) lines.push(`\n截图：${screenshots.join(', ')}`);
  lines.push('');
  lines.push(failed.length ? `${failed.length} 步失败` : `全部 ${steps.length} 步通过`);
  return lines.join('\n');
}

function finish(result) {
  return { ...result, summary: result.summary ?? summarize(result.steps, result.screenshots) };
}
