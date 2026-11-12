#!/usr/bin/env bash
# Runs the deploy regression tests (temporary fixtures and mocked commands only).
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
RC=0

for t in "$HERE"/dist-lib.test.sh "$HERE"/upgrade-sandbox.test.sh; do
  printf '== %s\n' "$(basename "$t")"
  bash "$t" || RC=1
done

printf '== metadata-writer.test.mjs\n'
node --test "$HERE/metadata-writer.test.mjs" || RC=1

if [ "$RC" -ne 0 ]; then
  printf 'deploy tests: FAILED\n'
  exit 1
fi
printf 'deploy tests: PASSED\n'
exit 0
