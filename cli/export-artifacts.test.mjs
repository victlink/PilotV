// export-artifacts 的测试。重点不是「有没有产出文件」，而是三件容易悄悄出错的事：
//   1. 汇总数字能不能被明细复算出来（手抄/半页统计的历史债）；
//   2. 数字在 xlsx 里是不是真的是数字（字符串列求和得 0，看着正常实则全错）；
//   3. 分页会不会「看着完整、其实只有最近一页」。
// xlsx 没有库可读，所以这里自带一个极小解包器：只读 local file header + inflate，
// 够把单元格逐个核对回去。

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import zlib from 'node:zlib';

import {
  MAX_PAGES,
  PAGE_LIMIT,
  buildCsv,
  buildRows,
  buildSheets,
  buildXlsx,
  aggregate,
  exportArtifacts,
  fetchArtifacts,
  summarize,
} from './export-artifacts.mjs';

const MB = 1024 * 1024;

function artifact(overrides = {}) {
  return {
    id: 'art_1',
    title: '标题',
    kind: 'image',
    status: 'ready',
    deliverable: 'final',
    project: 'proj-a',
    agent: 'watcher',
    run_id: 'run-1',
    version: 1,
    open_notes: 0,
    size: 2048,
    file_name: 'a.png',
    mime: 'image/png',
    ts: '2026-11-07T10:00:00+08:00',
    entry: { url: '/api/artifacts/art_1/raw' },
    ...overrides,
  };
}

/** 只解析 local file header：够用，且不需要任何第三方依赖。 */
function readZip(buf) {
  const files = new Map();
  let offset = 0;
  while (offset + 4 <= buf.length && buf.readUInt32LE(offset) === 0x04034b50) {
    const method = buf.readUInt16LE(offset + 8);
    const compressedSize = buf.readUInt32LE(offset + 18);
    const nameLength = buf.readUInt16LE(offset + 26);
    const extraLength = buf.readUInt16LE(offset + 28);
    const name = buf.subarray(offset + 30, offset + 30 + nameLength).toString('utf8');
    const start = offset + 30 + nameLength + extraLength;
    const raw = buf.subarray(start, start + compressedSize);
    files.set(name, method === 8 ? zlib.inflateRawSync(raw) : Buffer.from(raw));
    offset = start + compressedSize;
  }
  return files;
}

function parseCells(xml) {
  // sheet 结构是自己生成的，按 row/c 逐个抓即可，不引 XML 解析器。
  const rows = [];
  for (const rowXml of xml.split('<row ').slice(1)) {
    const cells = [];
    for (const chunk of rowXml.split('<c ').slice(1)) {
      const ref = /r="([A-Z]+\d+)"/.exec(chunk)?.[1] || '';
      const style = /s="(\d+)"/.exec(chunk)?.[1] ?? null;
      const type = /t="([a-zA-Z]+)"/.exec(chunk)?.[1] || null;
      const numeric = /<v>([^<]*)<\/v>/.exec(chunk)?.[1];
      const text = /<t xml:space="preserve">([\s\S]*?)<\/t>/.exec(chunk)?.[1];
      cells.push({ ref, style, type, value: numeric !== undefined ? numeric : text ?? null });
    }
    rows.push(cells);
  }
  return rows;
}

function sheetOf(files, index) {
  return parseCells(files.get(`xl/worksheets/sheet${index}.xml`).toString('utf8'));
}

test('buildRows：缺失字段补 0 而不是留 undefined，日期只取到日', () => {
  const [row] = buildRows([artifact({ size: undefined, run_id: null, ts: undefined })]);
  assert.equal(row.bytes, 0);
  assert.equal(row.mb, 0);
  assert.equal(row.runId, '');
  assert.equal(row.date, '');
  assert.equal(row.version, 1, 'version 缺失时按第 1 版');
});

test('buildRows：MB 换算保留三位，url 拼上访问 origin', () => {
  const [row] = buildRows([artifact({ size: 3 * MB })], { base: 'https://host:5186/' });
  assert.equal(row.mb, 3);
  assert.equal(row.url, 'https://host:5186/api/artifacts/art_1/raw');
});

test('aggregate：按条数倒序，同数按 key 排，空值单列一组', () => {
  const rows = buildRows([
    artifact({ id: 'a', kind: 'image' }),
    artifact({ id: 'b', kind: 'page' }),
    artifact({ id: 'c', kind: 'page' }),
    artifact({ id: 'd', kind: '' }),
  ]);
  const groups = aggregate(rows, (row) => row.kind);
  assert.deepEqual(groups.map((g) => g.key), ['page', '(空)', 'image']);
  assert.equal(groups[0].count, 2);
  assert.equal(groups[0].bytes, 4096);
});

test('summarize：每个数都是明细算出来的，空集合不会出 NaN', () => {
  const empty = summarize([]);
  assert.equal(empty.count, 0);
  assert.equal(empty.bytes, 0);
  assert.equal(empty.mb, 0);
  assert.equal(empty.firstDate, '');

  const rows = buildRows([
    artifact({ id: 'a', status: 'rework', open_notes: 2, project: 'p1' }),
    artifact({ id: 'b', size: 0, project: 'p2', run_id: '' }),
  ]);
  const totals = summarize(rows);
  assert.equal(totals.count, 2);
  assert.equal(totals.bytes, 2048);
  assert.equal(totals.openNotes, 2);
  assert.equal(totals.withNotes, 1);
  assert.equal(totals.rework, 1);
  assert.equal(totals.projects, 2);
  assert.equal(totals.sessions, 1, '空归属的会话不计入');
  assert.equal(totals.missingSize, 1, '体积为 0 要如实报出来，不推断');
});

test('buildSheets：分组表的「合计」恒等于明细求和', () => {
  const artifacts = [
    artifact({ id: 'a', kind: 'image', size: 1000 }),
    artifact({ id: 'b', kind: 'image', size: 250 }),
    artifact({ id: 'c', kind: 'doc', size: 500, status: 'rework' }),
  ];
  const sheets = buildSheets(artifacts);
  const detail = sheets.find((s) => s.name === '明细');
  assert.equal(detail.rows.length, 3);

  const byKind = sheets.find((s) => s.name === '按类型');
  const last = byKind.rows[byKind.rows.length - 1];
  assert.equal(last[0], '合计');
  const body = byKind.rows.slice(0, -1);
  assert.equal(last[1], body.reduce((sum, r) => sum + r[1], 0), '条数合计');
  assert.equal(last[3], body.reduce((sum, r) => sum + r[3], 0), '字节合计');
  assert.ok(Math.abs(last[2] - 1) < 1e-9, '占比加总为 1');

  const summary = Object.fromEntries(sheets.find((s) => s.name === '汇总').rows.map((r) => [r[0], r[1]]));
  assert.equal(summary['成果总数'], detail.rows.length);
  assert.equal(summary['待返工(rework)'], 1);
});

test('buildXlsx：合法 zip，六张表都在，工作表名没被转义破坏', () => {
  const files = readZip(buildXlsx(buildSheets([artifact()])));
  assert.ok(files.has('[Content_Types].xml'));
  assert.ok(files.has('xl/styles.xml'));
  assert.ok(files.get('xl/worksheets/sheet6.xml').length > 0);
  const names = [...files.get('xl/workbook.xml').toString('utf8').matchAll(/name="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(names, ['汇总', '按类型', '按状态', '按项目', '按来源', '明细']);
});

test('buildXlsx：数值格是真数字、带数字格式，文本格是 inlineStr', () => {
  const files = readZip(buildXlsx(buildSheets([artifact({ size: 12345 })])));
  const detail = sheetOf(files, 6);
  const dataRow = detail[1];
  const bytes = dataRow[10]; // 字节
  assert.equal(bytes.value, '12345');
  assert.equal(bytes.type, null, '数值格不能带 t= 属性');
  assert.equal(bytes.style, '2', '字节走千分位整数格式');
  assert.equal(dataRow[11].style, '3', 'MB 走小数格式');
  assert.equal(dataRow[0].type, 'inlineStr');
  assert.equal(detail[0][0].style, '1', '表头加粗');

  const byKind = sheetOf(files, 2);
  assert.equal(byKind[1][2].style, '4', '占比走百分比格式');
  assert.ok(Number(byKind[1][2].value) > 0 && Number(byKind[1][2].value) <= 1, '存小数、显示成百分比');
});

test('buildXlsx：汇总表里的小数不能套整数格式（显示 11 而存 11.435 是最坏的错）', () => {
  const big = artifact({ id: 'big', size: 11.435 * MB });
  const files = readZip(buildXlsx(buildSheets([big])));
  const summary = sheetOf(files, 1);
  const mbRow = summary.find((row) => row[0].value === '总体积(MB)');
  assert.equal(mbRow[1].value, '11.435');
  assert.notEqual(mbRow[1].style, '2', '小数套整数格式会在 Excel 里显示成 11');
  const countRow = summary.find((row) => row[0].value === '成果总数');
  assert.equal(countRow[1].style, '2', '整数仍走千分位');
});

test('buildXlsx：标题里的 XML 控制字符被剥掉、尖括号被转义', () => {
  const files = readZip(buildXlsx(buildSheets([
    artifact({ title: '坏\u0000标题 <script>alert(1)</script> & "引号"' }),
  ])));
  const xml = files.get('xl/worksheets/sheet6.xml').toString('utf8');
  assert.ok(!/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(xml), '控制字符会让整个工作簿打不开');
  assert.ok(xml.includes('&lt;script&gt;'));
  assert.ok(xml.includes('&amp;'));
  assert.ok(!/<script>/.test(xml));
});

test('buildXlsx：每个条目的 CRC 与解压后的内容一致（CRC 写错 = Excel 报「文件已损坏」）', () => {
  // 用 zlib.crc32 独立算一遍，不复用实现里的那张表 —— 自己验自己等于没验。
  const buf = buildXlsx(buildSheets([artifact({ title: '中文标题 with ascii and 1234' })]));
  const entries = [];
  let offset = 0;
  while (offset + 4 <= buf.length && buf.readUInt32LE(offset) === 0x04034b50) {
    const method = buf.readUInt16LE(offset + 8);
    const crcStored = buf.readUInt32LE(offset + 14);
    const compressedSize = buf.readUInt32LE(offset + 18);
    const uncompressedSize = buf.readUInt32LE(offset + 22);
    const nameLength = buf.readUInt16LE(offset + 26);
    const extraLength = buf.readUInt16LE(offset + 28);
    const name = buf.subarray(offset + 30, offset + 30 + nameLength).toString('utf8');
    const start = offset + 30 + nameLength + extraLength;
    const body = buf.subarray(start, start + compressedSize);
    entries.push({ name, method, crcStored, uncompressedSize, body });
    offset = start + compressedSize;
  }
  assert.equal(entries.length, 6 + 5, '五张固定部件 + 六张工作表');
  for (const entry of entries) {
    const raw = entry.method === 8 ? zlib.inflateRawSync(entry.body) : entry.body;
    assert.equal(raw.length, entry.uncompressedSize, `${entry.name} 声明长度对不上`);
    assert.equal(zlib.crc32(raw), entry.crcStored, `${entry.name} 的 CRC 对不上`);
  }
});
test('buildCsv：BOM + CRLF，含逗号引号换行的字段被正确引用', () => {
  const sheets = buildSheets([artifact({ title: 'a,b "c"\nd' })]);
  const sheet = sheets[sheets.length - 1];
  const csv = buildCsv(sheet);
  assert.ok(csv.startsWith('\ufeff'));
  assert.ok(csv.includes('\r\n'));
  assert.ok(csv.includes('"a,b ""c""\nd"'));
});

test('fetchArtifacts：取满一页继续翻页，短页即停；不看服务端那个「本页条数」式的 total', async () => {
  const full = Array.from({ length: PAGE_LIMIT }, (_, i) => artifact({ id: `f${i}` }));
  const tail = Array.from({ length: 30 }, (_, i) => artifact({ id: `t${i}` }));
  const seen = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    seen.push(new URL(url).searchParams.get('offset'));
    const batch = seen.length === 1 ? full : tail;
    return { ok: true, status: 200, json: async () => ({ artifacts: batch, total: batch.length }) };
  };
  try {
    const result = await fetchArtifacts({ base: 'http://127.0.0.1:8799' });
    assert.deepEqual(seen, ['0', '200']);
    assert.equal(result.artifacts.length, PAGE_LIMIT + 30);
    assert.equal(result.complete, true);
  } finally {
    globalThis.fetch = original;
  }
});

test('fetchArtifacts：翻到上限仍取满 -> 明确报不完整，而不是悄悄交出缺尾部的表', async () => {
  const full = Array.from({ length: PAGE_LIMIT }, (_, i) => artifact({ id: `f${i}` }));
  const original = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ artifacts: full, total: full.length }) });
  try {
    const result = await fetchArtifacts({ base: 'http://127.0.0.1:8799' });
    assert.equal(result.artifacts.length, PAGE_LIMIT * MAX_PAGES);
    assert.equal(result.complete, false);
  } finally {
    globalThis.fetch = original;
  }
});

test('fetchArtifacts：连不上与 401 分开说（前者该启动服务，后者该查凭据）', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
  };
  await assert.rejects(() => fetchArtifacts({ base: 'http://127.0.0.1:1' }), /连不上.*ECONNREFUSED/);

  globalThis.fetch = async () => ({ ok: false, status: 401 });
  await assert.rejects(() => fetchArtifacts({ base: 'http://127.0.0.1:8799' }), /HTTP 401[\s\S]*--token/);

  globalThis.fetch = async () => ({ ok: false, status: 500 });
  await assert.rejects(() => fetchArtifacts({ base: 'http://127.0.0.1:8799' }), /HTTP 500/);
  globalThis.fetch = original;
});

test('exportArtifacts：写出可解包的 xlsx，汇总与文件内明细自洽', async () => {
  const artifacts = [
    artifact({ id: 'a', kind: 'image', size: 4096 }),
    artifact({ id: 'b', kind: 'doc', size: 1024, status: 'rework', open_notes: 3 }),
  ];
  const original = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ artifacts, total: artifacts.length }) });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pilotv-export-'));
  try {
    const out = path.join(dir, 'nested', 'artifacts.xlsx');
    const result = await exportArtifacts({ out, base: 'http://127.0.0.1:8799' });
    assert.equal(result.ok, true);
    assert.equal(result.exitCode, 0);
    assert.equal(result.totals.count, 2);
    assert.ok(fs.existsSync(out), '中间目录要自动建出来');

    const files = readZip(fs.readFileSync(out));
    const detail = sheetOf(files, 6);
    const recomputed = detail.slice(1).reduce((sum, row) => sum + Number(row[10].value || 0), 0);
    assert.equal(recomputed, 5120);
    const summary = Object.fromEntries(sheetOf(files, 1).slice(1).map((row) => [row[0].value, row[1].value]));
    assert.equal(Number(summary['成果总数']), detail.length - 1);
    assert.equal(Number(summary['待处理标注']), 3);

    const csv = await exportArtifacts({ out: path.join(dir, 'a.csv'), base: 'http://127.0.0.1:8799' });
    assert.equal(csv.format, 'csv');
    assert.ok(fs.readFileSync(path.join(dir, 'a.csv'), 'utf8').startsWith('\ufeffID,'));
  } finally {
    globalThis.fetch = original;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('exportArtifacts：读不到服务时失败原因里带上 URL，不是一句「命令挂了」', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } }); };
  try {
    const result = await exportArtifacts({ base: 'http://nope.invalid:8799' });
    assert.equal(result.ok, false);
    assert.equal(result.exitCode, 1);
    assert.match(result.summary, /读取成果清单失败/);
    assert.match(result.summary, /nope\.invalid:8799/);
  } finally {
    globalThis.fetch = original;
  }
});

test('exportArtifacts：不认识的格式返回退出码 2（用法错），和跑挂的 1 分开', async () => {
  const result = await exportArtifacts({ format: 'txt', out: 'x.txt' });
  assert.equal(result.exitCode, 2);
  assert.equal(result.ok, false);
});