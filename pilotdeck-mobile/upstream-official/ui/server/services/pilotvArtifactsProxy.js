// PilotV 成果台代理 —— 上游 PilotDeck 没有这一层。
//
// 背景：成果台的数据在 8799（service/serve_artifacts.py），页面上请求
// /api/artifacts/... 用的是相对路径。走 PilotV 网关（5186）时网关会把它
// 转给 8799；但直接用上游的 Web 服务（3001）打开同一个页面时没有这一层，
// 成果台请求全部 404 —— 前端报「成果列表请求失败（HTTP 404）。请检查成果
// API 是否可用后刷新」。新风机项目的成果台就是这么打不开的：数据一直在，
// 只是 3001 上没人把请求转给 8799。
//
// 这一层把 3001 上的 /api/artifacts*、/artifacts-static/* 转给本机 8799，
// 让「本机直接开 3001」和「走网关 5186」两条路看到的成果一致。
//
// 鉴权跟成果台自己一套规矩（artifacts_console.py 的 _authorized）：
// 本机回环放行；其余调用方要么带机器令牌，要么带上游登录态。
// 不能只套上游的 authenticateToken：成果台前端用的是裸 fetch，不带
// Authorization 头，只套它会把本机用户也挡在门外。

import fs from 'fs';
import http from 'http';
import https from 'https';
import os from 'os';
import path from 'path';

const DEFAULT_TARGET = 'http://127.0.0.1:8799';

/**
 * 上游静默多久算死了（毫秒）。按「静默」而不是「总时长」算：成果台有 SSE
 * （/api/artifacts/events）和大文件下载，响应中间可以长时间没有输出。
 */
const UPSTREAM_IDLE_MS = 120000;

/**
 * 哪些路径归成果台。别的 /api/* 一律不碰。
 *
 * 只收 /artifacts/rooms 这一个页面路径：上游的 SPA 自己也有 /artifacts 路由，
 * 把 /artifacts/* 整段吃掉会把页面导航弄坏。
 */
export function isArtifactsPath(pathname) {
  if (typeof pathname !== 'string' || !pathname) return false;
  if (pathname === '/api/artifacts' || pathname.startsWith('/api/artifacts/')) return true;
  if (pathname.startsWith('/artifacts-static/')) return true;
  if (pathname === '/artifacts/rooms') return true;
  return false;
}

/** 成果台地址。没配就用本机默认端口。 */
export function resolveArtifactsTarget(env = process.env) {
  const raw = String(env.PILOTV_ARTIFACTS_TARGET || env.ARTIFACTS_TARGET || DEFAULT_TARGET).trim();
  try {
    return new URL(raw).origin;
  } catch {
    return DEFAULT_TARGET;
  }
}

/**
 * 机器令牌。优先环境变量，其次令牌文件（start-windows.ps1 用
 * --token-file 传给成果台进程，令牌就落在 ~/.pilotdeck/artifacts-token）。
 */
export function readArtifactsToken(env = process.env) {
  const inline = String(env.PILOTV_ARTIFACTS_TOKEN || '').trim();
  if (inline) return inline;
  const file = String(
    env.PILOTV_ARTIFACTS_TOKEN_FILE || path.join(os.homedir(), '.pilotdeck', 'artifacts-token'),
  ).trim();
  try {
    return fs.readFileSync(file, 'utf-8').trim();
  } catch {
    return '';
  }
}

/** 调用方是不是本机回环。 */
export function isLoopbackRequest(req) {
  const raw = String((req.socket && req.socket.remoteAddress) || req.ip || '');
  const address = raw.startsWith('::ffff:') ? raw.slice(7) : raw;
  return address === '127.0.0.1' || address === '::1' || address.startsWith('127.');
}

/** 调用方自带的机器令牌。 */
export function callerToken(req) {
  const header = req.headers['x-artifacts-token'];
  if (typeof header === 'string' && header.trim()) return header.trim();
  const auth = String(req.headers.authorization || '');
  if (auth.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();
  return '';
}

/**
 * 造一个成果台代理中间件。
 *
 * 目标与令牌默认取环境变量；测试可以自己传进来。
 *
 * authenticate 是「非回环调用方又没有机器令牌」时的兜底门禁（上游的
 * authenticateToken）。不直接 import 是为了这一层不牵进数据库和配置校验，
 * 单测能单独把它拉起来。
 */
export function createPilotVArtifactsProxy(options = {}) {
  const target = options.target || resolveArtifactsTarget();
  const token = options.token !== undefined ? options.token : readArtifactsToken();
  const idleMs = Number(options.idleMs) > 0 ? Number(options.idleMs) : UPSTREAM_IDLE_MS;
  const authenticate = typeof options.authenticate === 'function' ? options.authenticate : null;

  function forward(req, res) {
    let upstreamTarget;
    try {
      upstreamTarget = new URL(target);
    } catch {
      res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(`成果台地址无效：${target}`);
      return;
    }

    const headers = { ...req.headers, host: upstreamTarget.host };
    // 改写 Host 之后上游就不知道用户是从哪个入口来的，成果台拼评审链接要靠
    // 这两个头（跟网关那边同一套做法）。
    headers['x-forwarded-host'] = req.headers.host || (req.socket && req.socket.localAddress) || '';
    headers['x-forwarded-proto'] = upstreamTarget.protocol === 'https:' ? 'https' : 'http';
    // 调用方自己的凭据不能原样送进成果台：那是跨源凭据外泄面（浏览器的会话
    // cookie、Bearer 令牌都会跟着进去）。有机器令牌就换成我们的，没有就让
    // 成果台按它自己的规矩（回环放行）处理。
    delete headers.authorization;
    delete headers['x-artifacts-token'];
    delete headers.cookie;
    if (token) headers.authorization = `Bearer ${token}`;

    const upstreamIsTls = upstreamTarget.protocol === 'https:';
    const upstream = (upstreamIsTls ? https : http).request(
      {
        hostname: upstreamTarget.hostname,
        port: upstreamTarget.port || (upstreamIsTls ? 443 : 80),
        method: req.method,
        path: req.originalUrl,
        headers,
        rejectUnauthorized: false,
      },
      (upstreamResponse) => {
        res.writeHead(upstreamResponse.statusCode || 502, upstreamResponse.headers);
        upstreamResponse.pipe(res);
      },
    );

    upstream.setTimeout(idleMs, () => {
      if (!res.headersSent) {
        res.writeHead(504, { 'content-type': 'text/plain; charset=utf-8' });
      }
      res.end(`成果台 ${upstreamTarget.host} 超过 ${Math.round(idleMs / 1000)} 秒没有任何响应`);
      upstream.destroy();
    });
    upstream.on('error', (error) => {
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
      }
      res.end(`成果台 ${upstreamTarget.host} 无响应：${error.code || error.message}`);
    });
    req.pipe(upstream);
  }

  return function pilotvArtifactsProxy(req, res, next) {
    if (!isArtifactsPath(req.path)) {
      next();
      return;
    }

    // 本机回环放行；其余调用方要么出示机器令牌，要么带上游登录态。
    const machineOk = Boolean(token) && callerToken(req) === token;
    if (!isLoopbackRequest(req) && !machineOk) {
      if (!authenticate) {
        res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('成果台只对本机回环开放；跨机请走 PilotV 网关（5186）。');
        return;
      }
      authenticate(req, res, (error) => {
        if (error) {
          next(error);
          return;
        }
        forward(req, res);
      });
      return;
    }

    forward(req, res);
  };
}
