#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// PILOTV_WEB_BUILD_OUTPUT lets an isolated staging build write the metadata
// outside the served dist (see deploy/upgrade.sh).
const output = path.resolve(process.env.PILOTV_WEB_BUILD_OUTPUT || process.argv[2] || path.join(root, 'dist'));
let metadata = { sourceSha: null, tagName: null, clean: false, buildTime: new Date().toISOString() };
try {
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  const sourceSha = git('rev-parse', 'HEAD');
  const clean = git('status', '--porcelain', '--untracked-files=all') === '';
  const tagName = git('tag', '--points-at', 'HEAD', '--sort=-version:refname').split('\n')
    // Upstream release tags (vYYYY.MM.DD[-rN]) and the compact governance tags
    // (vYYYYMMDD.N[-rcN]) are both valid release markers.
    .find((tag) => /^(?:v\d{4}\.\d{2}\.\d{2}(?:-r\d+)?|v\d{8}\.\d+(?:-(?:rc|r)\d+)?)$/.test(tag)) || null;
  metadata = { ...metadata, sourceSha, tagName, clean };
} catch {
  // Archives and Docker builds remain buildable, with self-update disabled.
}
mkdirSync(output, { recursive: true });
writeFileSync(path.join(output, 'web-build.json'), `${JSON.stringify(metadata, null, 2)}\n`);
