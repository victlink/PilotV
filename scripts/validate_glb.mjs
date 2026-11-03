// 用 Khronos 官方 gltf-validator 过一遍我们自己写的 GLB。
// scripts/check_glb.py 只查容器和数值，spec 层面（属性名、组件类型、
// bufferView 边界、材质合法性）得让官方校验器说。
//
//   node scripts/validate_glb.mjs testdata/cad/*.glb
//
// 注意：issues 是 {numErrors, numWarnings, messages[]}，不是 {errors, warnings}。
// 早先按后者解构，缺字段被默认值兜住 → 校验器其实什么都没报，脚本永远 PASS。
// 结尾会拿一份故意改坏的 GLB 做反向验证，确认它真的会 FAIL。

import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

const require = createRequire('/tmp/gltfcheck/');
const validator = require('gltf-validator');

async function run(path, bytes) {
  const report = await validator.validateBytes(new Uint8Array(bytes));
  const issues = report.issues || {};
  const messages = issues.messages || [];
  for (const issue of messages) {
    if (issue.severity <= 1) console.log(`  ${issue.severity === 0 ? 'ERROR' : 'WARN '} ${path}: ${issue.message} @ ${issue.pointer}`);
  }
  console.log(`${(issues.numErrors || 0) ? 'FAIL' : 'PASS'} ${path}: `
    + `${report.info?.totalTriangleCount ?? '?'} tris, ${report.info?.totalVertexCount ?? '?'} verts, `
    + `${issues.numErrors || 0} errors, ${issues.numWarnings || 0} warnings`);
  return issues.numErrors || 0;
}

let bad = 0;
const paths = process.argv.slice(2);
for (const path of paths) {
  bad += await run(path, await readFile(path));
}

// 反向验证：把 "meshes" 这个关键字改坏，官方校验器必须报 ERROR。
// 少了这一步，一个永远返回 0 错误的校验脚本会让你以为产物是好的。
if (paths.length) {
  const original = await readFile(paths[0]);
  const broken = Buffer.from(original);
  const at = broken.indexOf(Buffer.from('"meshes"'));
  if (at < 0) throw new Error('反向验证失败：GLB 里找不到 meshes 字段');
  broken[at + 1] = 0x58; // m -> X
  const control = await validator.validateBytes(new Uint8Array(broken));
  const caught = control.issues?.numErrors || 0;
  console.log(`${caught ? 'PASS' : 'FAIL'} 反向验证：故意改坏 ${paths[0]} → ${caught} errors`);
  if (!caught) bad += 1;
}
process.exit(bad ? 1 : 0);
