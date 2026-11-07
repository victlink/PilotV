// pilotv export —— 把成果台导成 xlsx / csv。
//
// 两条硬约束，都是直接从「人工整理表格」踩出来的：
//   1. 数字必须由代码算。汇总表的每一个合计都是对明细做 reduce 得来的，
//      不手抄、不在文档里写死。明细改了汇总自动跟着变 —— 手抄的表第一次
//      修正明细之后就开始骗人。
//   2. 数字要真的是数字。xlsx 里条数/字节/占比写进数值单元格并带数字格式，
//      不是「"278"」这种字符串 —— 字符串列在 Excel 里求和会得到 0，
//      看起来正常、结果是错的，比直接报错更糟。
//
// 零依赖：环境里没有 exceljs/xlsx/openpyxl，所以按 OOXML 手写最小 xlsx
// （inline string + deflate + 手写 central directory）。写出器是纯函数，
// 测试里把 buffer 解回来逐格核对，不靠「打开看看好像是对的」。

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

export const PAGE_LIMIT = 200;
export const MAX_PAGES = 100;

/** 明细列定义：header 给表头，type 决定 xlsx 的数字格式。 */
export const COLUMNS = [
  { key: 'id', header: 'ID', type: 'text' },
  { key: 'title', header: '标题', type: 'text' },
  { key: 'kind', header: '类型', type: 'text' },
  { key: 'status', header: '状态', type: 'text' },
  { key: 'deliverable', header: '交付级别', type: 'text' },
  { key: 'project', header: '项目', type: 'text' },
  { key: 'agent', header: '来源', type: 'text' },
  { key: 'runId', header: '会话', type: 'text' },
  { key: 'version', header: '版本', type: 'number' },
  { key: 'openNotes', header: '待处理标注', type: 'number' },
  { key: 'bytes', header: '字节', type: 'number' },
  { key: 'mb', header: 'MB', type: 'decimal' },
  { key: 'fileName', header: '文件名', type: 'text' },
  { key: 'mime', header: 'MIME', type: 'text' },
  { key: 'date', header: '日期', type: 'text' },
  { key: 'url', header: '链接', type: 'text' },
];

const MB = 1024 * 1024;

function round(value, digits = 3) {
  const factor = 10 ** digits;
  return Math.round((Number(value) || 0) * factor) / factor;
}

function asNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/**
 * 明细行：一条成果一行，字段缺失补 0 / 空串。
 * 缺 size 与 size=0 在求和时没区别，但在「数据本身不全」这件事上有区别，
 * 所以这里不试图推断，只如实按 0 计并在汇总里报缺字段条数。
 */
export function buildRows(artifacts, { base = '' } = {}) {
  return (artifacts || []).map((a) => {
    const entry = a.entry || {};
    const bytes = asNumber(a.size);
    const runId = typeof a.run_id === 'string' ? a.run_id : '';
    return {
      id: a.id || '',
      title: a.title || '',
      kind: a.kind || '',
      status: a.status || '',
      deliverable: a.deliverable || '',
      project: a.project || '',
      agent: a.agent || '',
      runId,
      version: asNumber(a.version) || 1,
      openNotes: asNumber(a.open_notes),
      bytes,
      mb: round(bytes / MB),
      fileName: a.file_name || '',
      mime: a.mime || '',
      date: typeof a.ts === 'string' ? a.ts.slice(0, 10) : '',
      url: entry.url && base ? `${base.replace(/\/$/, '')}${entry.url}` : (entry.url || ''),
    };
  });
}

/** 按某个字段分组统计：条数 / 字节 / 待处理标注，按条数倒序。 */
export function aggregate(rows, pick) {
  const buckets = new Map();
  for (const row of rows) {
    const key = pick(row) || '(空)';
    const hit = buckets.get(key) || { key, count: 0, bytes: 0, openNotes: 0 };
    hit.count += 1;
    hit.bytes += row.bytes;
    hit.openNotes += row.openNotes;
    buckets.set(key, hit);
  }
  return [...buckets.values()].sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
}

/**
 * 汇总指标：全部从 rows 现场算。
 * 服务端 stats 只在「一页装得下」时等于全量，而导出是多页拉取的，
 * 直接搬 stats 会得到「按第一页算的总数」，所以这里一律不信它。
 */
export function summarize(rows) {
  const totalBytes = rows.reduce((sum, row) => sum + row.bytes, 0);
  const dates = rows.map((row) => row.date).filter(Boolean).sort();
  return {
    count: rows.length,
    bytes: totalBytes,
    mb: round(totalBytes / MB),
    openNotes: rows.reduce((sum, row) => sum + row.openNotes, 0),
    projects: new Set(rows.map((row) => row.project).filter(Boolean)).size,
    sessions: new Set(rows.map((row) => row.runId).filter(Boolean)).size,
    rework: rows.filter((row) => row.status === 'rework').length,
    withNotes: rows.filter((row) => row.openNotes > 0).length,
    missingSize: rows.filter((row) => row.bytes === 0).length,
    firstDate: dates[0] || '',
    lastDate: dates[dates.length - 1] || '',
  };
}

/** 占比写成小数（0.76），由 xlsx 的百分比格式显示成 76.0%。 */
function share(part, whole) {
  return whole > 0 ? round(part / whole, 5) : 0;
}

/**
 * 组装工作表。汇总在前、明细在后：打开文件第一眼是结论，
 * 需要核对时再翻明细 —— 汇总的每个数都能被明细复算出来。
 */
export function buildSheets(artifacts, { base = '' } = {}) {
  const rows = buildRows(artifacts, { base });
  const totals = summarize(rows);
  const byKind = aggregate(rows, (row) => row.kind);
  const byStatus = aggregate(rows, (row) => row.status);
  const byProject = aggregate(rows, (row) => row.project);
  const byAgent = aggregate(rows, (row) => row.agent);

  const summaryRows = [
    ['成果总数', totals.count, 0],
    ['总体积(MB)', totals.mb, 0],
    ['待处理标注', totals.openNotes, 0],
    ['有标注的成果数', totals.withNotes, 0],
    ['待返工(rework)', totals.rework, 0],
    ['项目数', totals.projects, 0],
    ['有归属的会话数', totals.sessions, 0],
    ['体积为 0 的条目(疑似缺元数据)', totals.missingSize, 0],
    ['最早日期', totals.firstDate, 0],
    ['最晚日期', totals.lastDate, 0],
    ['导出时间', new Date().toISOString().slice(0, 19).replace('T', ' '), 0],
  ];

  return [
    {
      name: '汇总',
      headers: ['指标', '数值'],
      types: ['text', 'mixed'],
      widths: [30, 24],
      rows: summaryRows.map(([label, value]) => [label, value]),
    },
    {
      name: '按类型',
      headers: ['类型', '条数', '占比', '字节', 'MB'],
      types: ['text', 'number', 'percent', 'number', 'decimal'],
      widths: [14, 10, 10, 14, 12],
      rows: byKind.map((g) => [g.key, g.count, share(g.count, totals.count), g.bytes, round(g.bytes / MB)])
        .concat([['合计', totals.count, 1, totals.bytes, totals.mb]]),
    },
    {
      name: '按状态',
      headers: ['状态', '条数', '占比', '字节'],
      types: ['text', 'number', 'percent', 'number'],
      widths: [14, 10, 10, 14],
      rows: byStatus.map((g) => [g.key, g.count, share(g.count, totals.count), g.bytes])
        .concat([['合计', totals.count, 1, totals.bytes]]),
    },
    {
      name: '按项目',
      headers: ['项目', '条数', '占比', 'MB', '待处理标注'],
      types: ['text', 'number', 'percent', 'decimal', 'number'],
      widths: [40, 10, 10, 12, 12],
      rows: byProject.map((g) => [g.key, g.count, share(g.count, totals.count), round(g.bytes / MB), g.openNotes]),
    },
    {
      name: '按来源',
      headers: ['来源', '条数', '占比'],
      types: ['text', 'number', 'percent'],
      widths: [16, 10, 10],
      rows: byAgent.map((g) => [g.key, g.count, share(g.count, totals.count)]),
    },
    {
      name: '明细',
      headers: COLUMNS.map((col) => col.header),
      types: COLUMNS.map((col) => col.type),
      widths: [12, 46, 10, 10, 12, 34, 12, 44, 8, 12, 12, 10, 34, 24, 12, 60],
      rows: rows.map((row) => COLUMNS.map((col) => row[col.key])),
    },
  ];
}

// ---------- 最小 xlsx 写出器（零依赖） ----------

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0 ^ -1;
  for (let i = 0; i < buf.length; i += 1) c = (c >>> 8) ^ CRC_TABLE[(c ^ buf[i]) & 0xff];
  return (c ^ -1) >>> 0;
}

function columnLetter(index) {
  let n = index + 1;
  let out = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

function escapeXml(value) {
  // 控制字符（除 tab/lf/cr）在 XML 里非法：成果标题里混过这类字节，
  // 不剥掉的话整个工作簿打不开，而且报错只说「文件已损坏」。
  return String(value)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

/**
 * ZIP（deflate + 手写 central directory）。
 * 条目时间固定为同一天：同一份数据两次导出应得到逐字节相同的文件，
 * 否则「导出结果对不上」永远分不清是数据变了还是时间戳变了。
 */
function zip(entries) {
  const DOS_TIME = 0;
  const DOS_DATE = 0x2821; // 2000-01-01
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const raw = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
    const deflated = zlib.deflateRawSync(raw, { level: 9 });
    const useDeflate = deflated.length < raw.length;
    const body = useDeflate ? deflated : raw;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(raw);

    const local = Buffer.alloc(30 + nameBuf.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 文件名标志位
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    nameBuf.copy(local, 30);
    locals.push(local, body);

    const central = Buffer.alloc(46 + nameBuf.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk
    central.writeUInt16LE(0, 36); // internal attrs
    central.writeUInt32LE(0, 38); // external attrs
    central.writeUInt32LE(offset, 42);
    nameBuf.copy(central, 46);
    centrals.push(central);

    offset += local.length + body.length;
  }

  const centralBuf = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, centralBuf, end]);
}

// 样式表：自定义数字格式 164=小数 165=百分比，3=千分位整数。
// 类型 → 样式下标的映射见 STYLE_BY_TYPE；表头单独一个加粗样式。
const STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="2"><numFmt numFmtId="164" formatCode="0.000"/><numFmt numFmtId="165" formatCode="0.0%"/></numFmts>
<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>
<fills count="1"><fill><patternFill patternType="none"/></fill></fills>
<borders count="1"><border/></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="5">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="3" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
</cellXfs>
</styleSheet>`;

const STYLE_BY_TYPE = { text: 0, number: 2, decimal: 3, percent: 4, mixed: 0 };

function cellXml(ref, value, type) {
  if (value === null || value === undefined || value === '') return `<c r="${ref}"/>`;
  const isMixedNumber = type === 'mixed' && typeof value === 'number';
  if ((type === 'number' || type === 'decimal' || type === 'percent' || isMixedNumber)
      && typeof value === 'number' && Number.isFinite(value)) {
    // mixed 列（汇总表）整数走千分位、小数走 General：把 11.435 塞进千分位
    // 整数格式，Excel 显示成「11」—— 文件里存的对、看起来是错的，比报错更难查。
    const style = isMixedNumber
      ? (Number.isInteger(value) ? STYLE_BY_TYPE.number : 0)
      : (STYLE_BY_TYPE[type] || 0);
    return `<c r="${ref}" s="${style}"><v>${value}</v></c>`;
  }
  return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(value)}</t></is></c>`;
}

function sheetXml(sheet) {
  const cols = sheet.widths && sheet.widths.length
    ? `<cols>${sheet.widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>`
    : '';
  const header = `<row r="1">${sheet.headers
    .map((h, i) => `<c r="${columnLetter(i)}1" s="1" t="inlineStr"><is><t xml:space="preserve">${escapeXml(h)}</t></is></c>`)
    .join('')}</row>`;
  const body = sheet.rows.map((row, rowIndex) => {
    const r = rowIndex + 2;
    return `<row r="${r}">${sheet.headers.map((_, c) => cellXml(`${columnLetter(c)}${r}`, row[c], sheet.types[c])).join('')}</row>`;
  }).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
<sheetData>${header}${body}</sheetData>
${cols}</worksheet>`;
}

function safeSheetName(name, index) {
  const cleaned = String(name).replace(/[[\]:*?/\\]/g, ' ').trim().slice(0, 31);
  return cleaned || `Sheet${index + 1}`;
}

export function buildXlsx(sheets) {
  const names = sheets.map((s, i) => safeSheetName(s.name, i));
  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}
</Types>`;

  const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;

  const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets>${names.map((n, i) => `<sheet name="${escapeXml(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets>
</workbook>`;

  const workbookRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}
<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;

  return zip([
    { name: '[Content_Types].xml', data: contentTypes },
    { name: '_rels/.rels', data: rootRels },
    { name: 'xl/workbook.xml', data: workbook },
    { name: 'xl/_rels/workbook.xml.rels', data: workbookRels },
    { name: 'xl/styles.xml', data: STYLES_XML },
    ...sheets.map((s, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: sheetXml(s) })),
  ]);
}

/** RFC 4180 + BOM：Excel 直接双击打开 csv 时中文不乱码。 */
export function buildCsv(sheet) {
  const cell = (value) => {
    if (value === null || value === undefined) return '';
    const text = String(value);
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const lines = [sheet.headers, ...sheet.rows].map((row) => row.map(cell).join(','));
  return `\ufeff${lines.join('\r\n')}\r\n`;
}

// ---------- 采集 + 命令 ----------

const DEFAULT_BASE = 'http://127.0.0.1:8799';

/**
 * 分页拉全量。
 * 服务端 limit 上限 1000、默认 200，而它返回的 total 是「这一页的条数」
 * 不是全表条数 —— 按 total 判断是否取完会在 200 条时误停，导出一份
 * 看起来完整、其实只有最近一页的表。所以用「取满一页就继续翻」判断。
 */
export async function fetchArtifacts({ base = DEFAULT_BASE, token, timeoutMs = 15000 } = {}) {
  const collected = [];
  const pages = [];
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const url = `${base.replace(/\/$/, '')}/api/artifacts?limit=${PAGE_LIMIT}&offset=${page * PAGE_LIMIT}`;
    const headers = token ? { authorization: `Bearer ${token}` } : {};
    let response;
    try {
      response = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      const reason = error && (error.name === 'TimeoutError' || error.name === 'AbortError')
        ? `${url} 超时（${timeoutMs}ms 无响应）`
        : `${url} 连不上：${error && error.cause && error.cause.code ? error.cause.code : (error && error.message) || '未知原因'}`;
      const wrapped = new Error(reason);
      wrapped.stage = 'fetch';
      wrapped.url = url;
      throw wrapped;
    }
    if (!response.ok) {
      const hint = response.status === 401 || response.status === 403
        ? '（需要登录：用 --token 传 Bearer，或对着已登录的 origin 跑）'
        : '';
      throw new Error(`${url} 返回 HTTP ${response.status} ${hint}`);
    }
    const payload = await response.json();
    const batch = Array.isArray(payload.artifacts) ? payload.artifacts : [];
    collected.push(...batch);
    pages.push(batch.length);
    if (batch.length < PAGE_LIMIT) return { artifacts: collected, pages, complete: true };
  }
  // 翻到上限还没取完：明确说不完整，而不是悄悄交出一份缺尾部的表。
  return { artifacts: collected, pages, complete: false };
}

function textSummary({ file, format, totals, sheets, complete, pages }) {
  const lines = [
    `已导出 ${file}`,
    `格式：${format}　工作表：${sheets.map((s) => s.name).join(' / ')}`,
    `明细 ${totals.count} 条 / ${totals.mb} MB　待处理标注 ${totals.openNotes}　待返工 ${totals.rework}`,
    `项目 ${totals.projects} 个　有归属会话 ${totals.sessions} 个　日期区间 ${totals.firstDate || '?'} ~ ${totals.lastDate || '?'}`,
  ];
  if (totals.missingSize > 0) lines.push(`注意：${totals.missingSize} 条体积记为 0（元数据缺失，未做推断）`);
  if (!complete) lines.push(`注意：分页达到上限 ${MAX_PAGES} 页（共 ${pages.reduce((a, b) => a + b, 0)} 条），结果不完整`);
  lines.push('汇总数字全部由明细现场计算，可与明细页复算核对。');
  return lines.join('\n');
}

export async function exportArtifacts(options = {}) {
  const format = options.format || (String(options.out || '').toLowerCase().endsWith('.csv') ? 'csv' : 'xlsx');
  if (format !== 'xlsx' && format !== 'csv') {
    return { ok: false, summary: `不支持的格式 "${format}"，只认 xlsx / csv`, exitCode: 2 };
  }

  let fetched;
  try {
    fetched = await fetchArtifacts({ base: options.base || DEFAULT_BASE, token: options.token || process.env.PILOTV_ARTIFACTS_TOKEN });
  } catch (error) {
    // 「服务没起」和「服务起了但拒绝」要分开说：前者该去启动，后者该去查凭据。
    return { ok: false, summary: `读取成果清单失败：${error.message}`, error, exitCode: 1 };
  }

  const sheets = buildSheets(fetched.artifacts, { base: options.base || DEFAULT_BASE });
  const totals = summarize(buildRows(fetched.artifacts, { base: options.base || DEFAULT_BASE }));

  const outDir = options.outDir || path.join('review', 'exports');
  const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '');
  const fileName = options.out || path.join(outDir, `pilotv-artifacts-${stamp}.${format}`);
  fs.mkdirSync(path.dirname(path.resolve(fileName)), { recursive: true });

  if (format === 'csv') {
    fs.writeFileSync(fileName, buildCsv(sheets[sheets.length - 1]));
  } else {
    fs.writeFileSync(fileName, buildXlsx(sheets));
  }

  return {
    ok: true,
    file: path.resolve(fileName),
    format,
    totals,
    sheets: sheets.map((s) => ({ name: s.name, rows: s.rows.length })),
    complete: fetched.complete,
    pages: fetched.pages,
    summary: textSummary({
      file: path.resolve(fileName), format, totals, sheets,
      complete: fetched.complete, pages: fetched.pages,
    }),
    exitCode: 0,
  };
}