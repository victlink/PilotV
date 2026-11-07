#!/usr/bin/env node
// Repository hygiene gate, runnable on any OS with no dependencies.
//
// Why this exists: docs/HANDOFF-Windows-20261105.md #3.1 records an autostart
// loop that grew .run/autostart.log to 1.82 GB. The cause was a .cmd file saved
// with LF endings plus UTF-8 Chinese comments: cmd.exe mis-tracks its own line
// offsets and chopped `powershell` into `hell`. verify_windows.ps1 section 3
// already checks this, but it is PowerShell-only and nothing enforced it, so
// start-agent-window.cmd fell back into the same shape weeks later.
//
// What is checked, and against what:
//   * Batch/shell/BOM rules read the CHECKED-OUT file, not the stored blob.
//     .gitattributes stores *.cmd as LF and materialises CRLF on checkout, so
//     the blob can never answer "what does cmd.exe actually parse" - only the
//     working tree can. That is also what a CI checkout produces.
//   * The .gitattributes rules themselves are asserted, otherwise the
//     normalisation above is silently unenforced and this file checks nothing.
//   * Committed runtime/backup junk is rejected by path.
//
// Usage: node scripts/ci/check-repo-hygiene.mjs

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

const tracked = () => execFileSync('git', ['ls-files'], { encoding: 'utf8' })
  .split('\n').filter(Boolean);

const JUNK_PATTERNS = [
  { pattern: /^\.run\/(?!agent-supervisor\.(cmd|mjs)$)/, why: '.run/ is runtime state; only the supervisor pair belongs in git' },
  { pattern: /(^|\/)dist\.bak\./, why: 'hand-named build backup' },
  { pattern: /(^|\/)dist\.old\./, why: 'hand-named build backup' },
  { pattern: /\.bak[-.]/, why: 'manual backup left next to the original' },
];

const scan = (buffer) => {
  let lf = 0;
  let crlf = 0;
  let loneCr = 0;
  let nonAscii = 0;
  for (let index = 0; index < buffer.length; index += 1) {
    const byte = buffer[index];
    if (byte === 0x0a) {
      lf += 1;
      if (index > 0 && buffer[index - 1] === 0x0d) crlf += 1;
    } else if (byte === 0x0d && buffer[index + 1] !== 0x0a) {
      loneCr += 1;
    }
    if (byte > 0x7f) nonAscii += 1;
  }
  return {
    lf,
    crlf,
    loneCr,
    nonAscii,
    bareLf: lf - crlf,
    bom: buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf,
  };
};

const failures = [];

// 1. The normalisation contract has to exist for the rest of this to mean anything.
const attributesPath = '.gitattributes';
if (!existsSync(attributesPath)) {
  failures.push('.gitattributes is missing; without it core.autocrlf makes every tracked file look modified after a cross-platform sync');
} else {
  const attributes = readFileSync(attributesPath, 'utf8');
  const required = [
    [/^\s*\*\s+text=auto eol=lf\s*$/m, '* text=auto eol=lf'],
    [/^\s*\*\.cmd\s+text eol=crlf\s*$/m, '*.cmd text eol=crlf'],
    [/^\s*\*\.sh\s+text eol=lf\s*$/m, '*.sh text eol=lf'],
  ];
  for (const [rule, label] of required) {
    if (!rule.test(attributes)) failures.push(`.gitattributes lost the rule "${label}"`);
  }
}

// 2. Per-file checks against the checked-out bytes.
for (const file of tracked()) {
  const junk = JUNK_PATTERNS.find((entry) => entry.pattern.test(file));
  if (junk) {
    failures.push(`${file}: ${junk.why}`);
    continue;
  }

  let buffer;
  try {
    buffer = readFileSync(file);
  } catch {
    continue; // removed from disk but still indexed; `git ls-files -d` covers that
  }
  const stats = scan(buffer);

  if (/\.(cmd|bat)$/i.test(file)) {
    if (stats.bareLf > 0) {
      failures.push(`${file}: ${stats.bareLf} bare LF line(s); cmd.exe reads this file with wrong line offsets (HANDOFF #3.1 autostart loop)`);
    }
    if (stats.nonAscii > 0) {
      failures.push(`${file}: ${stats.nonAscii} non-ASCII byte(s); batch files must stay pure ASCII (HANDOFF #3.1)`);
    }
    if (stats.bom) failures.push(`${file}: UTF-8 BOM breaks "@echo off"`);
  }

  if (/\.sh$/i.test(file) && (stats.crlf > 0 || stats.loneCr > 0)) {
    failures.push(`${file}: contains CR; bash fails on "set -e\\r" (CRLF=${stats.crlf} loneCR=${stats.loneCr})`);
  }

  // Windows PowerShell 5.1 needs the BOM to decode non-ASCII text correctly,
  // and rejects it nowhere; it is deliberate on .ps1 and a mistake elsewhere.
  if (/\.ps1$/i.test(file)) {
    if (stats.nonAscii > 0 && !stats.bom) {
      failures.push(`${file}: non-ASCII text without a UTF-8 BOM; Windows PowerShell 5.1 mis-decodes it`);
    }
  } else if (stats.bom && !/\.(json|jsonc)$/i.test(file)) {
    failures.push(`${file}: unexpected UTF-8 BOM`);
  }
}

if (failures.length > 0) {
  console.error(`Repository hygiene: ${failures.length} problem(s)`);
  for (const failure of failures) console.error(`  x ${failure}`);
  console.error('\nContext: .gitattributes and docs/HANDOFF-Windows-20261105.md section 3.1.');
  process.exit(1);
}

console.log('Repository hygiene: OK');