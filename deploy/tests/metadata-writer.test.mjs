// Regression tests for pilotdeck-mobile/upstream-official/scripts/write-web-build-metadata.mjs
//
// Scope: temporary fixtures plus a mocked `git` on PATH. The writer is copied
// into a temporary directory so the real ui/dist is never written.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const WRITER = path.join(REPO, 'pilotdeck-mobile', 'upstream-official', 'scripts', 'write-web-build-metadata.mjs');

function sandbox(tags) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pilotv-metadata-'));
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(root, 'bin'), { recursive: true });
  fs.copyFileSync(WRITER, path.join(root, 'scripts', 'write-web-build-metadata.mjs'));
  const git = `#!/usr/bin/env bash
case "\${1:-}" in
  rev-parse) echo "0123456789abcdef0123456789abcdef01234567" ;;
  status) echo "" ;;
  tag) printf '%s\\n' "${tags}" ;;
  *) exit 1 ;;
esac
exit 0
`;
  fs.writeFileSync(path.join(root, 'bin', 'git'), git, { mode: 0o755 });
  return root;
}

function run(root, args = [], env = {}) {
  return execFileSync(process.execPath, [path.join(root, 'scripts', 'write-web-build-metadata.mjs'), ...args], {
    env: { ...process.env, PATH: `${path.join(root, 'bin')}:${process.env.PATH}`, ...env },
    encoding: 'utf8',
  });
}

function readMetadata(root, dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, 'web-build.json'), 'utf8'));
}

test('compact release tag v20261111.1-rc1 is accepted', () => {
  const root = sandbox('v20261111.1-rc1');
  const out = path.join(root, 'out');
  run(root, [out]);
  assert.equal(readMetadata(root, out).tagName, 'v20261111.1-rc1');
});

test('compact release tag v20261111.1 is accepted', () => {
  const root = sandbox('v20261111.1');
  const out = path.join(root, 'out');
  run(root, [out]);
  assert.equal(readMetadata(root, out).tagName, 'v20261111.1');
});

test('upstream tag format v2026.11.11 is still accepted', () => {
  const root = sandbox('v2026.11.11');
  const out = path.join(root, 'out');
  run(root, [out]);
  assert.equal(readMetadata(root, out).tagName, 'v2026.11.11');
});

test('upstream tag format v2026.11.11-r1 is still accepted', () => {
  const root = sandbox('v2026.11.11-r1');
  const out = path.join(root, 'out');
  run(root, [out]);
  assert.equal(readMetadata(root, out).tagName, 'v2026.11.11-r1');
});

test('unrelated tags are rejected', () => {
  const root = sandbox('release-20261111');
  const out = path.join(root, 'out');
  run(root, [out]);
  assert.equal(readMetadata(root, out).tagName, null);
});

test('PILOTV_WEB_BUILD_OUTPUT redirects the metadata away from the served dist', () => {
  const root = sandbox('v20261111.1-rc1');
  const stage = path.join(root, 'stage');
  run(root, [], { PILOTV_WEB_BUILD_OUTPUT: stage });
  assert.equal(readMetadata(root, stage).tagName, 'v20261111.1-rc1');
  assert.equal(fs.existsSync(path.join(root, 'dist', 'web-build.json')), false);
});
