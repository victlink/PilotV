// PilotV 网关的实机验收：对着真的 PilotDeck 后端跑一遍关键路径。
// 用法：node pilotdeck-mobile/scripts/gateway-live-check.mjs [网关地址]
// 默认检查 http://127.0.0.1:5199（先起一个测试实例），传 5186 就查线上那套。

import net from 'node:net';
import http from 'node:http';

const base = process.argv[2] || 'http://127.0.0.1:5199';
const { hostname, port } = new URL(base);

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? '✔' : '✘'} ${name}${detail ? `  ${detail}` : ''}`);
  if (!ok) failures += 1;
}

function get(path, cookie) {
  return new Promise(resolve => {
    const request = http.get({ host: hostname, port, path, headers: cookie ? { cookie } : {}, agent: false }, response => {
      let body = '';
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body }));
    });
    request.on('error', error => resolve({ status: 0, body: error.message }));
  });
}

function runtimeOf(body) {
  const match = /window\.__PILOTV__=(\{.*?\});/.exec(body);
  return match ? JSON.parse(match[1]) : null;
}

/** 手工做一次 WebSocket 握手，读回状态行即可判断网关有没有把 upgrade 转发出去。 */
function upgrade(path) {
  return new Promise(resolve => {
    const socket = net.connect(Number(port), hostname, () => {
      socket.write(`GET ${path} HTTP/1.1\r\nHost: ${hostname}:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`);
    });
    let data = '';
    socket.on('data', chunk => {
      data += chunk;
      if (data.includes('\r\n\r\n')) { socket.destroy(); resolve(data.split('\r\n')[0]); }
    });
    socket.on('error', () => resolve('连接失败'));
    setTimeout(() => { socket.destroy(); resolve(data.split('\r\n')[0] || '超时'); }, 6000).unref();
  });
}

console.log(`检查 ${base}\n`);

const home = await get('/');
check('首页可打开', home.status === 200 && Boolean(runtimeOf(home.body)));
const runtime = runtimeOf(home.body);
check('首页注入了当前后端', Boolean(runtime?.backend), runtime?.backend);
check('默认设备名可读', Boolean(runtime?.defaultName), runtime?.defaultName);

const jx88 = 'http://100.108.86.109:3001';
const viaQuery = await get(`/?d=${encodeURIComponent(jx88)}`);
const queryRuntime = runtimeOf(viaQuery.body);
check('?d= 切到目标设备', queryRuntime?.backend === jx88, queryRuntime?.backend);
check('切换后记住了选择', /pdv_backend=http%3A%2F%2F100\.108\.86\.109%3A3001/.test(viaQuery.headers['set-cookie']?.[0] || ''));

const jxProjects = await get('/api/projects', 'pdv_backend=http://100.108.86.109:3001');
const remoteProjects = JSON.parse(jxProjects.body);
check('REST 来自远端后端', jxProjects.status === 200 && remoteProjects.some(p => String(p.fullPath).startsWith('/home/jx88')),
  remoteProjects[0]?.fullPath);

const localProjects = JSON.parse((await get('/api/projects')).body);
check('不传 Cookie 时回到本机后端', localProjects.every(p => !String(p.fullPath).startsWith('/home/jx88')),
  localProjects[0]?.fullPath);

const remoteArtifacts = await get('/api/artifacts', 'pdv_backend=http://100.108.86.109:3001');
check('成果台跟随设备', remoteArtifacts.status === 200, `jx88 /api/artifacts -> ${remoteArtifacts.status}`);

const wsRemote = await upgrade('/ws');
const wsLocal = await upgrade('/ws?skip=1');
check('WebSocket 升级转发到当前设备', /101/.test(wsRemote) || /40[13]/.test(wsRemote), wsRemote.trim());
check('另一个设备同样是活的连接', wsLocal.length > 0, wsLocal.trim());

const unknown = await get('/api/projects', 'pdv_backend=http://169.254.169.254:80');
const unknownProjects = JSON.parse(unknown.body);
check('陌生地址不会被代理（已回落本机）', !String(unknownProjects[0]?.fullPath).includes('169.254'),
  unknownProjects[0]?.fullPath);

console.log(`\n${failures ? `${failures} 项不通过` : '全部通过'}`);
process.exit(failures ? 1 : 0);