// @vitest-environment node
// 成果台代理的回归测试。
//
// 这层代理是为了修「新风机项目成果台报 HTTP 404」而加的：页面上请求的是相对
// 路径 /api/artifacts/...，直接开 3001（上游 PilotDeck Web）时上游没有这一层
// 路由，必然 404。所以这里盯住三件容易悄悄坏掉的事：
//   1. 哪些路径归成果台 —— 吃太多会把上游 SPA 的 /artifacts 页面导航弄坏；
//   2. POST 的 body 会不会被吃掉（挂载位置在 express.json 之前就是为了这个）；
//   3. 鉴权门禁 —— 本机回环放行，跨机要么机器令牌要么上游登录态。

import http from 'node:http';
import { Writable } from 'node:stream';

import { afterEach, describe, expect, it } from 'vitest';

import {
  callerToken,
  createPilotVArtifactsProxy,
  isArtifactsPath,
  isLoopbackRequest,
  readArtifactsToken,
  resolveArtifactsTarget,
} from './pilotvArtifactsProxy.js';

const cleanups = [];
afterEach(async () => {
  for (const clean of cleanups.splice(0).reverse()) await clean();
});

/** 起一个假的成果台服务，把收到的请求原样回显。 */
async function startUpstream(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  cleanups.push(() => new Promise((resolve) => {
    server.closeAllConnections();
    server.close(resolve);
  }));
  return { server, origin };
}

/** 回显型上游：把 method / url / body / 关键请求头回给调用方。 */
function echoHandler(request, response) {
  const chunks = [];
  request.on('data', (chunk) => chunks.push(chunk));
  request.on('end', () => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({
      method: request.method,
      url: request.url,
      body: Buffer.concat(chunks).toString('utf-8'),
      authorization: request.headers.authorization || '',
      cookie: request.headers.cookie || '',
      artifactsToken: request.headers['x-artifacts-token'] || '',
      host: request.headers.host || '',
      forwardedHost: request.headers['x-forwarded-host'] || '',
    }));
  });
}

/** 假的请求对象：socket 地址可以随便定，用来区分回环和跨机。 */
function fakeRequest(options = {}) {
  const {
    method = 'GET',
    path = '/api/artifacts/workspace',
    headers = {},
    remoteAddress = '127.0.0.1',
    body = null,
  } = options;
  return {
    method,
    path,
    originalUrl: path,
    headers,
    socket: { remoteAddress },
    pipe(upstream) {
      if (body) upstream.write(body);
      upstream.end();
      return upstream;
    },
  };
}

/** 假的响应对象：能接住上游 pipe 过来的字节。 */
function fakeResponse() {
  const chunks = [];
  let resolveDone;
  const done = new Promise((resolve) => { resolveDone = resolve; });
  const response = new Writable({
    write(chunk, encoding, callback) {
      chunks.push(Buffer.from(chunk));
      callback();
    },
    final(callback) {
      resolveDone();
      callback();
    },
  });
  response.statusCode = 200;
  response.headers = {};
  response.writeHead = (statusCode, headers) => {
    response.statusCode = statusCode;
    response.headers = headers || {};
    return response;
  };
  response.bodyText = () => Buffer.concat(chunks).toString('utf-8');
  response.done = done;
  return response;
}

describe('isArtifactsPath', () => {
  it('认得成果台自己的路径', () => {
    expect(isArtifactsPath('/api/artifacts')).toBe(true);
    expect(isArtifactsPath('/api/artifacts/workspace')).toBe(true);
    expect(isArtifactsPath('/api/artifacts/rooms')).toBe(true);
    expect(isArtifactsPath('/artifacts-static/vendor/model-viewer.min.js')).toBe(true);
    expect(isArtifactsPath('/artifacts/rooms')).toBe(true);
  });

  it('不吃上游 SPA 自己的 /artifacts 页面路由，也不碰别的 API', () => {
    expect(isArtifactsPath('/artifacts')).toBe(false);
    expect(isArtifactsPath('/artifacts/some-page')).toBe(false);
    expect(isArtifactsPath('/api/sessions')).toBe(false);
    expect(isArtifactsPath('/api/artifactsfoo')).toBe(false);
    expect(isArtifactsPath('')).toBe(false);
    expect(isArtifactsPath(undefined)).toBe(false);
  });
});

describe('resolveArtifactsTarget', () => {
  it('优先用环境变量里的成果台地址', () => {
    expect(resolveArtifactsTarget({ PILOTV_ARTIFACTS_TARGET: 'http://127.0.0.1:9999' })).toBe('http://127.0.0.1:9999');
    expect(resolveArtifactsTarget({ ARTIFACTS_TARGET: 'https://example.test:8443' })).toBe('https://example.test:8443');
  });

  it('没配或配错了就回本机默认端口', () => {
    expect(resolveArtifactsTarget({})).toBe('http://127.0.0.1:8799');
    expect(resolveArtifactsTarget({ PILOTV_ARTIFACTS_TARGET: '不是地址' })).toBe('http://127.0.0.1:8799');
  });
});

describe('readArtifactsToken', () => {
  it('先用环境变量里的令牌，其次读令牌文件', () => {
    expect(readArtifactsToken({ PILOTV_ARTIFACTS_TOKEN: ' abc ' })).toBe('abc');
    expect(readArtifactsToken({ PILOTV_ARTIFACTS_TOKEN_FILE: '不存在的文件' })).toBe('');
  });
});

describe('isLoopbackRequest', () => {
  it('认得本机回环，认不得跨机地址', () => {
    expect(isLoopbackRequest({ socket: { remoteAddress: '127.0.0.1' } })).toBe(true);
    expect(isLoopbackRequest({ socket: { remoteAddress: '::1' } })).toBe(true);
    expect(isLoopbackRequest({ socket: { remoteAddress: '::ffff:127.0.0.1' } })).toBe(true);
    expect(isLoopbackRequest({ socket: { remoteAddress: '100.120.169.61' } })).toBe(false);
    expect(isLoopbackRequest({ socket: {} })).toBe(false);
  });
});

describe('callerToken', () => {
  it('从 X-Artifacts-Token 或 Bearer 里取', () => {
    expect(callerToken({ headers: { 'x-artifacts-token': ' t1 ' } })).toBe('t1');
    expect(callerToken({ headers: { authorization: 'Bearer t2' } })).toBe('t2');
    expect(callerToken({ headers: {} })).toBe('');
  });
});

describe('成果台代理', () => {
  it('把成果台请求转给 8799，状态码和内容原样带回', async () => {
    const upstream = await startUpstream(echoHandler);
    const proxy = createPilotVArtifactsProxy({ target: upstream.origin, token: '' });
    const response = fakeResponse();
    proxy(fakeRequest({ path: '/api/artifacts/workspace?limit=2000' }), response, () => {
      throw new Error('成果台路径不该落到下一个中间件');
    });
    await response.done;
    expect(response.statusCode).toBe(200);
    const payload = JSON.parse(response.bodyText());
    expect(payload.url).toBe('/api/artifacts/workspace?limit=2000');
  });

  it('POST 的 body 要原样送到上游（挂载在 express.json 之前就是为了这个）', async () => {
    const upstream = await startUpstream(echoHandler);
    const proxy = createPilotVArtifactsProxy({ target: upstream.origin, token: '' });
    const response = fakeResponse();
    proxy(fakeRequest({
      method: 'POST',
      path: '/api/artifacts/import',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: 'a.png' }),
    }), response, () => {
      throw new Error('成果台路径不该落到下一个中间件');
    });
    await response.done;
    const payload = JSON.parse(response.bodyText());
    expect(payload.method).toBe('POST');
    expect(JSON.parse(payload.body)).toEqual({ path: 'a.png' });
  });

  it('不是成果台的路径就交给下一个中间件', async () => {
    const upstream = await startUpstream(echoHandler);
    const proxy = createPilotVArtifactsProxy({ target: upstream.origin, token: '' });
    let handedOver = false;
    proxy(fakeRequest({ path: '/api/sessions' }), fakeResponse(), () => { handedOver = true; });
    expect(handedOver).toBe(true);
  });

  it('调用方自己的凭据不外泄，改送我们自己的机器令牌', async () => {
    const upstream = await startUpstream(echoHandler);
    const proxy = createPilotVArtifactsProxy({ target: upstream.origin, token: 'machine-token' });
    const response = fakeResponse();
    proxy(fakeRequest({
      headers: { authorization: 'Bearer 上游的JWT', cookie: 'sid=abc', 'x-artifacts-token': '调用方的令牌' },
    }), response, () => {
      throw new Error('成果台路径不该落到下一个中间件');
    });
    await response.done;
    const payload = JSON.parse(response.bodyText());
    expect(payload.authorization).toBe('Bearer machine-token');
    expect(payload.cookie).toBe('');
    expect(payload.artifactsToken).toBe('');
  });

  it('本机回环直接放行，不问登录态', async () => {
    const upstream = await startUpstream(echoHandler);
    let authenticateCalled = false;
    const proxy = createPilotVArtifactsProxy({
      target: upstream.origin,
      token: '',
      authenticate: (req, res, next) => { authenticateCalled = true; next(new Error('不该走到这里')); },
    });
    const response = fakeResponse();
    proxy(fakeRequest({ remoteAddress: '127.0.0.1' }), response, () => {
      throw new Error('成果台路径不该落到下一个中间件');
    });
    await response.done;
    expect(authenticateCalled).toBe(false);
    expect(response.statusCode).toBe(200);
  });

  it('跨机访问没有凭据就 401，并提示走网关', async () => {
    const upstream = await startUpstream(echoHandler);
    const proxy = createPilotVArtifactsProxy({ target: upstream.origin, token: '' });
    const response = fakeResponse();
    proxy(fakeRequest({ remoteAddress: '100.120.169.61' }), response, () => {
      throw new Error('未通过鉴权不该落到下一个中间件');
    });
    await response.done;
    expect(response.statusCode).toBe(401);
    expect(response.bodyText()).toContain('5186');
  });

  it('跨机访问带对了机器令牌就放行', async () => {
    const upstream = await startUpstream(echoHandler);
    const proxy = createPilotVArtifactsProxy({ target: upstream.origin, token: 'machine-token' });
    const response = fakeResponse();
    proxy(fakeRequest({
      remoteAddress: '100.120.169.61',
      headers: { 'x-artifacts-token': 'machine-token' },
    }), response, () => {
      throw new Error('成果台路径不该落到下一个中间件');
    });
    await response.done;
    expect(response.statusCode).toBe(200);
  });

  it('跨机访问没有机器令牌时，交给上游自己的登录态校验', async () => {
    const upstream = await startUpstream(echoHandler);
    let nextError = null;
    let resolveNext;
    const nextCalled = new Promise((resolve) => { resolveNext = resolve; });
    const proxy = createPilotVArtifactsProxy({
      target: upstream.origin,
      token: 'machine-token',
      authenticate: (req, res, next) => next(new Error('未登录')),
    });
    const response = fakeResponse();
    proxy(fakeRequest({ remoteAddress: '100.120.169.61' }), response, (error) => {
      nextError = error;
      resolveNext();
    });
    await nextCalled;
    expect(nextError).toBeTruthy();
    expect(nextError.message).toBe('未登录');
  });

  it('成果台没起来的时候回 502，而不是 404', async () => {
    const upstream = await startUpstream(echoHandler);
    const origin = upstream.origin;
    await new Promise((resolve) => upstream.server.close(resolve));
    const proxy = createPilotVArtifactsProxy({ target: origin, token: '' });
    const response = fakeResponse();
    proxy(fakeRequest(), response, () => {
      throw new Error('成果台路径不该落到下一个中间件');
    });
    await response.done;
    expect(response.statusCode).toBe(502);
  });
});
