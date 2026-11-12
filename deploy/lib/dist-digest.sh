#!/usr/bin/env bash
# Shared bundle digest for the served UI dist.
#
# The digest must be stable across directories and machines, so it is computed
# over relative file names with LC_ALL=C ordering. Both deploy/upgrade.sh (the
# manifest writer) and deploy/verify-unity.sh (the drift check) use this
# helper, so one algorithm governs every consumer.
#
# Usage: pilotv_dist_digest <dir>  -> prints the hex digest, fails if <dir>
#                                       is not a directory.

pilotv_dist_digest() {
  local dir="${1:-}"
  [ -n "$dir" ] || return 1
  [ -d "$dir" ] || return 1
  (
    cd "$dir" || exit 1
    find . -type f -print0 \
      | LC_ALL=C sort -z \
      | xargs -0 -r sha256sum \
      | sha256sum \
      | awk '{print $1}'
  )
}
