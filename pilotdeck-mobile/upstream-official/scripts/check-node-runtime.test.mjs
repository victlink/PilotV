// Run with: node --test scripts/check-node-runtime.test.mjs
// The gate calls process.exit(1) on rejection, so each case runs in a child.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('./check-node-runtime.mjs', import.meta.url));

function check(version) {
  return spawnSync(process.execPath, [SCRIPT], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PILOTDECK_RUNTIME_CHECK_TEST_MODE: '1',
      PILOTDECK_TEST_NODE_VERSION: version,
      PILOTDECK_TEST_SKIP_SQLITE: '1',
    },
  });
}

for (const version of ['22.13.0', '22.22.2', '24.0.0', '24.22.3']) {
  test(`accepts ${version}`, () => {
    const result = check(version);
    assert.equal(result.status, 0, result.stderr);
  });
}

for (const version of ['22.12.9', '23.11.0', '25.0.0', '20.19.0']) {
  test(`rejects ${version}`, () => {
    const result = check(version);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Node\.js .* is required/);
  });
}

test('warns about the cppgc-affected 22.22.2 build', () => {
  const result = check('22.22.2');
  assert.equal(result.status, 0);
  assert.match(result.stdout + result.stderr, /Check failed: marking_done_/);
});

test('accepts the real running runtime', () => {
  const result = spawnSync(process.execPath, [SCRIPT], {
    encoding: 'utf8',
    env: { ...process.env, PILOTDECK_RUNTIME_CHECK_TEST_MODE: '0' },
  });
  assert.equal(result.status, 0, result.stderr);
});
