#!/usr/bin/env node
// Error-observability gate: an error must never be reported without also being logged.
//
// Why this exists (docs/HANDOFF-Windows-20261105.md section 2.1, docs/DEGRADATION.md section 4):
// telemetry.trackError() runs the error through normalizeErrorCode(), i.e. it keeps a code and
// throws the call site away. During the 2026-11-05 investigation the only surviving line was
// "[telemetry] shutdown snapshot", and two rounds were spent misdiagnosing a killed process as
// a clean exit. Reporting and logging are two different jobs; doing the first is not the second.
//
// Rules, both about errors that vanish without a trace:
//   R1  trackError(x.message)        - a string cannot carry a stack, by construction.
//   R2  catch (e) { trackError(e) }  - a handler whose only action is to report: the stack
//                                      exists at that moment and dies there.
//
// Existing violations are pinned in BASELINE with exact counts. New ones fail the build;
// fixing one also fails until the baseline is lowered, so the list cannot silently drift up
// or get quietly "fixed" by deleting the check. That is deliberate: the number is the record.
//
// Usage: node scripts/ci/check-error-observability.mjs [--baseline]
//   --baseline prints the current counts, for whoever is updating the numbers below.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const UPSTREAM = 'pilotdeck-mobile/upstream-official/';
// Tracked source we hold to this rule. The gateway lives under pilotdeck-mobile/ and the
// runtime under service/; both are ours to fix. Third-party vendored node_modules is out.
const PREFIXES = [UPSTREAM + 'src/', 'service/'];

// All seven original violations are fixed (the two above each had a comment explaining
// why a silent downgrade is not the same as an unrecorded one). Zero means the rule is now
// unconditional: any new reporting-without-logging fails the build.
const BASELINE = { R1: 0, R2: 0 };

const TEST_FILE = /\.test\.[cm]?[jt]s$/;
const TRACKER_ONLY = new Set([
  // The collector itself has to normalise; excluding it keeps the rule about call sites.
  UPSTREAM + 'src/telemetry/collector.ts',
]);

/**
 * Removes strings, template literals, comments and regex literals so that brace matching and
 * keyword search cannot be fooled by text inside them. Deliberately simple: this is a gate on
 * our own source, not a JS parser, and it fails closed (a mis-scan reports a violation, it
 * never hides one).
 */
function blankOut(source) {
  let out = '';
  let i = 0;
  const n = source.length;
  let prevMeaningful = '';
  const regexAllowed = () => /[=(,:[!&|?{};*%~^<>+\-]/.test(prevMeaningful);
  while (i < n) {
    const ch = source[i];
    const next = source[i + 1];
    if (ch === '/' && next === '/') {
      while (i < n && source[i] !== '\n') { out += ' '; i += 1; }
      continue;
    }
    if (ch === '/' && next === '*') {
      while (i < n && !(source[i] === '*' && source[i + 1] === '/')) { out += source[i] === '\n' ? '\n' : ' '; i += 1; }
      out += '  '; i += 2;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch;
      out += ' '; i += 1;
      while (i < n) {
        if (source[i] === '\\') { out += '  '; i += 2; continue; }
        if (source[i] === quote) { out += ' '; i += 1; break; }
        out += source[i] === '\n' ? '\n' : ' ';
        i += 1;
      }
      continue;
    }
    if (ch === '/' && regexAllowed()) {
      let j = i + 1;
      let closed = false;
      while (j < n && source[j] !== '\n') {
        if (source[j] === '\\') { j += 2; continue; }
        if (source[j] === '[') { j += 1; while (j < n && source[j] !== ']' && source[j] !== '\n') j += 1; }
        if (source[j] === '/') { closed = true; break; }
        j += 1;
      }
      if (closed) {
        for (let k = i; k <= j; k += 1) out += ' ';
        i = j + 1;
        prevMeaningful = '/';
        continue;
      }
    }
    out += ch;
    if (!/\s/.test(ch)) prevMeaningful = ch;
    i += 1;
  }
  return out;
}

function lineOf(source, index) {
  return source.slice(0, index).split('\n').length;
}

/** Yields { binding, body, start } for every catch clause in the (blanked) source. */
function catchBlocks(code) {
  const blocks = [];
  const re = /\bcatch\b\s*(?:\(\s*([A-Za-z_$][\w$]*)?\s*\))?\s*\{/g;
  let match;
  while ((match = re.exec(code))) {
    const open = match.index + match[0].length - 1;
    let depth = 1;
    let i = open + 1;
    while (i < code.length && depth > 0) {
      if (code[i] === '{') depth += 1;
      else if (code[i] === '}') depth -= 1;
      i += 1;
    }
    blocks.push({ binding: match[1] || '', body: code.slice(open + 1, i - 1), start: match.index });
  }
  return blocks;
}

const LOGGING = /\bconsole\.(?:error|warn|info|debug|log)\s*\(|\bdebugger\b|\.log\s*\(|\bsafeLog\s*\(|\breportException\s*\(|\blogger\s*\.\s*(?:error|warn|info|debug)\s*\(|\bprocess\.stderr\.write\s*\(/;
// Deliberately narrow. An earlier draft also matched a bare "error." prefix, which made
// `error.message` inside a handler look like a logging call and hid three real violations --
// a gate with a false negative is worse than no gate, because it is trusted.

function scanFile(file) {
  const found = [];
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    return found; // tracked but absent on disk; another gate covers that
  }
  const code = blankOut(raw);

  // R1: a stack cannot survive being narrowed to .message before it is reported.
  const narrowed = /\.trackError\s*\(\s*[A-Za-z_$][\w$]*(?:\??\.[A-Za-z_$][\w$]*)*\.message\b/g;
  let match;
  while ((match = narrowed.exec(code))) {
    found.push({ rule: 'R1', file, line: lineOf(raw, match.index), text: raw.split('\n')[lineOf(raw, match.index) - 1]?.trim() });
  }

  // R2: reporting without logging.
  for (const block of catchBlocks(code)) {
    if (!/\.trackError\s*\(/.test(block.body)) continue;
    if (LOGGING.test(block.body)) continue;
    // If the caught object is never handed to anything that could log it, the stack dies here.
    const usesBinding = block.binding && new RegExp(`\\b${block.binding}\\b`).test(block.body);
    if (!usesBinding) continue;
    found.push({ rule: 'R2', file, line: lineOf(raw, block.start), text: raw.split('\n')[lineOf(raw, block.start) - 1]?.trim() });
  }
  return found;
}

let trackedFiles = [];
try {
  trackedFiles = execFileSync('git', ['ls-files'], { encoding: 'utf8' }).split('\n').filter(Boolean);
} catch {
  console.error('Error observability: git ls-files failed; cannot prove anything, so failing closed.');
  process.exit(1);
}
const scanned = trackedFiles.filter((file) => PREFIXES.some((prefix) => file.startsWith(prefix)));
const considered = scanned.filter((file) => /\.[cm]?[jt]s$/.test(file) && !file.endsWith('.d.ts') && !TEST_FILE.test(file) && !TRACKER_ONLY.has(file));
const violations = [];
for (const file of considered) violations.push(...scanFile(file));

const counts = { R1: 0, R2: 0 };
for (const violation of violations) counts[violation.rule] += 1;

if (process.argv.includes('--baseline')) {
  console.log(JSON.stringify(counts));
  process.exit(0);
}

const problems = [];
for (const rule of Object.keys(BASELINE)) {
  if (counts[rule] > BASELINE[rule]) {
    problems.push(`${rule}: ${counts[rule]} violation(s), baseline is ${BASELINE[rule]}. New ones must be fixed, not baselined.`);
  } else if (counts[rule] < BASELINE[rule]) {
    problems.push(`${rule}: only ${counts[rule]} left but the baseline says ${BASELINE[rule]}. Lower it - this number is the record of a lesson already paid for.`);
  }
}

if (problems.length > 0) {
  console.error('Error observability: problems found');
  for (const problem of problems) console.error(`  x ${problem}`);
  const shown = violations.slice(0, 40);
  for (const violation of shown) console.error(`    ${violation.rule} ${violation.file}:${violation.line}  ${violation.text}`);
  if (violations.length > shown.length) console.error(`    ... ${violations.length - shown.length} more`);
  console.error('\nAn error must reach the log with its stack. telemetry.trackError() keeps a code and drops the stack.');
  console.error('See docs/DEGRADATION.md section 4 and docs/HANDOFF-Windows-20261105.md section 2.1.');
  process.exit(1);
}

console.log(`Error observability: OK - ${considered.length} file(s) scanned, ${counts.R1} R1 / ${counts.R2} R2 (at baseline)`);
