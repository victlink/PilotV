// Build real review samples so the artifact viewer's media paths can be verified
// instead of assumed: video with a timeline, 3D model, drawing, audio, html, text.
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const dir = 'pilotdeck-mobile/review/samples';
mkdirSync(dir, { recursive: true });
const out = name => path.join(dir, name);

// 1. 12s test pattern video with an audible tone: enough length to drag a timeline.
execFileSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=25:duration=12',
  '-f', 'lavfi', '-i', 'sine=frequency=440:duration=12',
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', out('sample.mp4')],
  { stdio: 'ignore' });

// 2. 3s audio-only sample.
execFileSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'sine=frequency=330:duration=3', out('sample.m4a')], { stdio: 'ignore' });

// 3. Drawing: an SVG plan with a few labelled parts.
writeFileSync(out('drawing.svg'), `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600" viewBox="0 0 800 600">
  <rect width="800" height="600" fill="#ffffff"/>
  <g stroke="#1f2937" stroke-width="2" fill="none">
    <rect x="60" y="60" width="680" height="480"/>
    <rect x="120" y="140" width="240" height="180"/>
    <circle cx="520" cy="230" r="70"/>
    <line x1="120" y1="400" x2="680" y2="400"/>
  </g>
  <g fill="#111827" font-family="sans-serif" font-size="18">
    <text x="180" y="235">机柜 A</text>
    <text x="480" y="235">转台</text>
    <text x="360" y="450">基准线</text>
  </g>
</svg>
`, 'utf8');

// 4. HTML page and a plain text page.
writeFileSync(out('sample.html'), `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<style>body{font-family:system-ui;padding:40px;background:#f8fafc;color:#0f172a}
h1{font-size:24px}table{border-collapse:collapse;margin-top:16px}
td,th{border:1px solid #cbd5e1;padding:8px 14px}</style></head>
<body><h1>验收报告（样例页）</h1>
<p>这是用于验证成果窗口渲染 HTML 的样例页面。</p>
<table><tr><th>项目</th><th>状态</th></tr><tr><td>官方 UI 一致性</td><td>通过</td></tr><tr><td>成果窗口</td><td>通过</td></tr></table>
</body></html>`, 'utf8');

writeFileSync(out('sample.txt'), `验收清单
1. 主窗口铺满，去掉左栏与顶栏
2. 标注同步进对话输入框
3. 视频可播放暂停并拖动时间线
4. 三维可旋转拖动缩放
`, 'utf8');

// 5. Minimal valid GLB: one coloured triangle, enough for orbit/zoom checks.
function glb() {
  const positions = new Float32Array([0, 0.6, 0, -0.6, -0.4, 0, 0.6, -0.4, 0]);
  const posBin = Buffer.from(positions.buffer);
  while (posBin.length % 4) posBin.push(0);
  const pad = Buffer.alloc((4 - (posBin.length % 4)) % 4);
  const bin = Buffer.concat([posBin, pad]);
  const bufferViews = [{ buffer: 0, byteOffset: 0, byteLength: posBin.length, target: 34962 }];
  const accessors = [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [-0.6, -0.4, 0], max: [0.6, 0.6, 0] }];
  const nodes = [{ mesh: 0 }];
  const meshes = [{ primitives: [{ attributes: { POSITION: 0 }, mode: 4 }] }];
  const gltf = {
    asset: { version: '2.0', generator: 'pilotdeck-review-sample' },
    scene: 0, scenes: [{ nodes: [0] }], nodes, meshes,
    accessors, bufferViews, buffers: [{ byteLength: bin.length }],
  };
  let json = Buffer.from(JSON.stringify(gltf), 'utf8');
  while (json.length % 4) json = Buffer.concat([json, Buffer.from(' ')]);
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0); header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + json.length + 8 + bin.length, 8);
  const jsonHeader = Buffer.alloc(8);
  jsonHeader.writeUInt32LE(json.length, 0); jsonHeader.writeUInt32LE(0x4e4f534a, 4);
  const binHeader = Buffer.alloc(8);
  binHeader.writeUInt32LE(bin.length, 0); binHeader.writeUInt32LE(0x004e4942, 4);
  return Buffer.concat([header, jsonHeader, json, binHeader, bin]);
}
writeFileSync(out('sample.glb'), glb());
console.log(dir);