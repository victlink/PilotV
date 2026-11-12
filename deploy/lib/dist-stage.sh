#!/usr/bin/env bash
# Helpers that publish a staged UI build without destroying the served dist.
#
# Contract:
#   * the build itself always happens outside the served directory
#   * publishing copies the staged files into the served directory and keeps
#     the files that only exist in the served directory, so the previously
#     served (hashed) assets stay reachable
#   * every file lands through a temporary file plus a rename, so a reader
#     never observes a half written file
#   * a restore brings the served directory back to the state of the snapshot
#
# Usage:
#   pilotv_dist_publish <stage-dir> <served-dir>
#   pilotv_dist_restore <served-dir> <snapshot-dir>

pilotv_dist_publish() {
  local stage="${1:-}" served="${2:-}"
  [ -n "$stage" ] && [ -n "$served" ] || return 1
  [ -d "$stage" ] || { echo "stage directory not found: $stage" >&2; return 1; }
  mkdir -p "$served" || return 1
  local f rel tmp phase is_entry
  # phase 1 publishes every asset, phase 2 publishes the entry documents, so a
  # reader never sees an index that references an asset which is not copied yet
  for phase in assets entry; do
    while IFS= read -r -d '' f; do
      rel="${f#./}"
      [ -n "$rel" ] || continue
      is_entry=0
      case "$rel" in
        index.html|*/index.html) is_entry=1 ;;
      esac
      if [ "$phase" = assets ] && [ "$is_entry" -eq 1 ]; then continue; fi
      if [ "$phase" = entry ] && [ "$is_entry" -eq 0 ]; then continue; fi
      mkdir -p "$served/$(dirname "$rel")" || return 1
      tmp="$served/.pilotv-publish.$$.tmp"
      cp -p "$stage/$rel" "$tmp" || { rm -f "$tmp"; return 1; }
      mv -f "$tmp" "$served/$rel" || { rm -f "$tmp"; return 1; }
    done < <(cd "$stage" && find . -type f -print0 | LC_ALL=C sort -z)
  done
  return 0
}

pilotv_dist_restore() {
  local served="${1:-}" backup="${2:-}"
  [ -n "$served" ] && [ -n "$backup" ] || return 1
  [ -d "$backup" ] || { echo "snapshot directory not found: $backup" >&2; return 1; }
  mkdir -p "$served" || return 1
  # Restore assets before entry documents using the same per-file rename path.
  # Only then remove files belonging exclusively to the failed build.
  pilotv_dist_publish "$backup" "$served" || return 1
  local f rel
  # drop the files that the snapshot does not know about (new build output)
  while IFS= read -r -d '' f; do
    rel="${f#./}"
    [ -n "$rel" ] || continue
    if [ ! -f "$backup/$rel" ]; then
      rm -f "$served/$rel" || return 1
    fi
  done < <(cd "$served" && find . -type f -print0 2>/dev/null)
  return 0
}
