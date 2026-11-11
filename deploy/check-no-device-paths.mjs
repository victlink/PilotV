#!/usr/bin/env node
// Guard against new device-specific absolute paths leaking into the repo.
//
// The 2026-11-11 audit found ~20 tracked files that hardcode one machine's
// fork checkout (/home/Marc/PilotDeck-src) or the legacy runtime shim
// (~/.pilotdeck/app). They are historical one-off acceptance probes and docs;
// rewriting them all is a separate cleanup. This gate freezes the list: any
// NEW reference in production code must be replaced by an env var / repo-relative
// path, otherwise a device upgrade silently breaks on another machine.
//
//   node deploy/check-no-device-paths.mjs

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NEEDLES = ['/home/Marc/PilotDeck-src', '~/.pilotdeck/app', '/home/jx88/PilotDeck-src'];

// Historical, non-production references. Keep this list shrinking, never growing.
const LEGACY_ALLOWED = [
  /\.md$/i,                          // docs legitimately discuss forbidden paths
  /^pilotdeck-mobile\/review\//,
  /^pilotdeck-mobile\/scripts\//,   // one-off browser acceptance probes
  /^pilotdeck-mobile\/upstream-official\/ui\/scripts\//, // one-off smoke probes
  /^cli\/.*\.test\.mjs$/,
  /^deploy\//,                      // governance files name the forbidden roots on purpose
  /^scripts\/_archive\//,
  /^scripts\/sync_project_team_runtime\.py$/, // deprecated, see its docstring
];

const files = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  .split('\n').map((s) => s.trim()).filter(Boolean);

const hits = [];
for (const rel of files) {
  if (LEGACY_ALLOWED.some((re) => re.test(rel))) continue;
  if (rel.includes('node_modules/') || /\.(png|jpg|jpeg|gif|webp|ico|woff2?|zip|gz|db|lock)$/i.test(rel)) continue;
  const full = path.join(ROOT, rel);
  let text;
  try { text = fs.readFileSync(full, 'utf8'); } catch { continue; }
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    for (const needle of NEEDLES) {
      if (line.includes(needle)) hits.push({ file: rel, line: i + 1, needle, text: line.trim().slice(0, 140) });
    }
  });
}

if (hits.length === 0) {
  console.log(`Device-path guard: OK (no new hardcoded device paths in ${files.length} tracked files).`);
  process.exit(0);
}
console.log(`Device-path guard: FAIL (${hits.length} new reference(s))`);
for (const h of hits.slice(0, 30)) console.log(`  ${h.file}:${h.line} [${h.needle}] ${h.text}`);
console.log('Replace absolute device paths with an env var or a repo-relative path.');
console.log('If the file is genuinely a historical artifact, add a NARROW entry to LEGACY_ALLOWED in this script.');
process.exit(1);
