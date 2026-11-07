// 门禁自己的测试。门禁最重要的能力是「会红」——一条永远不会红的检查
// 比没有检查更糟，因为它会被信任。所以正反两例都要断言。

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BASELINE,
  archivedNames,
  countTopLevelScripts,
  evaluate,
  findBrokenArchiveRefs,
  formatText,
} from './check-script-sprawl.mjs';

const FILES = [
  'scripts/deploy_pilotv_device.sh',
  'scripts/verify_loop.py',
  'scripts/_archive/dump_db.py',
  'scripts/_archive/probe_mcp.py',
  'scripts/ci/check-repo-hygiene.mjs',   // 子目录不算顶层
  'README.md',
  'docs/plan.md',
];

test('countTopLevelScripts：只数 scripts/ 顶层，子目录不算', () => {
  assert.deepEqual(countTopLevelScripts(FILES), ['scripts/deploy_pilotv_device.sh', 'scripts/verify_loop.py']);
  assert.deepEqual(countTopLevelScripts([]), []);
});

test('archivedNames：归档目录里的文件名，供断链检查用', () => {
  assert.deepEqual([...archivedNames(FILES)].sort(), ['dump_db.py', 'probe_mcp.py']);
  assert.equal(archivedNames(['README.md']).size, 0);
});

test('findBrokenArchiveRefs：按旧路径引用已归档脚本 = 断链', () => {
  const refs = new Map([['docs/plan.md', '跑 scripts/dump_db.py 看一眼\n']]);
  const broken = findBrokenArchiveRefs(['docs/plan.md'], new Set(['dump_db.py']), (f) => refs.get(f));
  assert.equal(broken.length, 1);
  assert.equal(broken[0].file, 'docs/plan.md');
  assert.equal(broken[0].target, 'scripts/dump_db.py');
});

test('findBrokenArchiveRefs：已改成新路径的不许误报（误报的门禁没人信）', () => {
  const refs = new Map([['docs/plan.md', '跑 scripts/_archive/dump_db.py 看一眼\n']]);
  assert.deepEqual(findBrokenArchiveRefs(['docs/plan.md'], new Set(['dump_db.py']), (f) => refs.get(f)), []);
});

test('findBrokenArchiveRefs：归档目录内部互相提到不算断链', () => {
  const refs = new Map([['scripts/_archive/a.py', '先跑 scripts/_archive/dump_db.py\n']]);
  assert.deepEqual(findBrokenArchiveRefs(['scripts/_archive/a.py'], new Set(['dump_db.py']), (f) => refs.get(f)), []);
});

test('findBrokenArchiveRefs：新旧路径混写时，只有写旧路径那一行算', () => {
  const refs = new Map([['README.md', '新：scripts/_archive/dump_db.py\n旧：scripts/dump_db.py\n']]);
  const broken = findBrokenArchiveRefs(['README.md'], new Set(['dump_db.py']), (f) => refs.get(f));
  assert.equal(broken.length, 1);
  assert.equal(broken[0].line, 2, '要指到具体行，否则几十行的文档里得找半天');
});

test('findBrokenArchiveRefs：文件读不到就跳过，不让门禁因为一个临时文件崩掉', () => {
  assert.deepEqual(findBrokenArchiveRefs(['gone.md'], new Set(['dump_db.py']), () => { throw new Error('ENOENT'); }), []);
});

test('evaluate：正好等于基线要放行（41 个才红）', () => {
  assert.equal(evaluate({ count: BASELINE, broken: [] }).ok, true);
  const over = evaluate({ count: BASELINE + 1, broken: [] });
  assert.equal(over.ok, false);
  assert.match(over.problems[0], new RegExp(String(BASELINE + 1)));
  assert.equal(evaluate({ count: 0, broken: [{ file: 'a.md', target: 'scripts/x.py' }] }).ok, false);
});

test('formatText：失败时必须给出可执行的下一步，而不是「数不对」', () => {
  const over = evaluate({ count: BASELINE + 3, broken: [] });
  over.archivedCount = 97;
  const text = formatText(over);
  assert.match(text, /FAIL/);
  assert.match(text, /pilotv/);
  assert.match(text, /_archive/);

  const ok = evaluate({ count: BASELINE, broken: [] });
  ok.archivedCount = 97;
  const good = formatText(ok);
  assert.equal(good.includes('FAIL'), false);
  assert.match(good, /OK/);
});

test('findBrokenArchiveRefs：归档内容里的陈旧写法不报 —— 有意豁免', () => {
  // 归档脚本不是运行手册。为它头注释里一句没改干净的旧路径把 CI 判红，
  // 会挡住与它毫无关系的提交；真要跑的人有的是办法找到它。
  // 这条豁免是取舍，不是遗漏，所以钉在这里。
  const refs = new Map([['scripts/_archive/a.py', '用法：python3 scripts/dump_db.py\n']]);
  assert.deepEqual(findBrokenArchiveRefs(['scripts/_archive/a.py'], new Set(['dump_db.py']), (f) => refs.get(f)), []);
});

test('findBrokenArchiveRefs：依赖目录不参与扫描', () => {
  const refs = new Map([['.venv/lib/x.md', 'scripts/dump_db.py'], ['node_modules/y.md', 'scripts/dump_db.py']]);
  const files = ['.venv/lib/x.md', 'node_modules/y.md'];
  assert.deepEqual(findBrokenArchiveRefs(files, new Set(['dump_db.py']), (f) => refs.get(f)), []);
});
