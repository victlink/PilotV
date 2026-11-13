import { existsSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/**
 * Bounded, append-only JSONL log rotation shared by the router stats log and
 * the router event bus.
 *
 * Oversized files are renamed to `<name>.<ISO timestamp>` (lexicographically
 * sortable). Oldest shards beyond `maxShards` are removed. Replay consumers
 * read every remaining shard in order, so statistics stay continuous and the
 * replay memory footprint is bounded by the streaming reader, not file size.
 */

export const ROUTER_LOG_MAX_BYTES = 16 * 1024 * 1024;
export const ROUTER_LOG_MAX_SHARDS = 8;

type RotationOptions = {
  maxBytes?: number;
  maxShards?: number;
  now?: () => Date;
};

function shardPrefix(filePath: string): string {
  return `${basename(filePath)}.`;
}

/** All archived shards (oldest first) plus the current file, if present. */
export function listRouterLogShards(filePath: string): string[] {
  const dir = dirname(filePath);
  const prefix = shardPrefix(filePath);
  const shards: string[] = [];
  try {
    const archives = readdirSync(dir)
      .filter((name) => name.startsWith(prefix))
      .sort();
    for (const name of archives) shards.push(join(dir, name));
  } catch { /* directory may not exist yet */ }
  if (existsSync(filePath)) shards.push(filePath);
  return shards;
}

/** Archive the current file when it exceeds `maxBytes`. Returns true if rotated. */
export function rotateRouterLogIfNeeded(
  filePath: string,
  options: RotationOptions = {},
): boolean {
  const maxBytes = options.maxBytes ?? ROUTER_LOG_MAX_BYTES;
  const maxShards = options.maxShards ?? ROUTER_LOG_MAX_SHARDS;
  try {
    if (!existsSync(filePath) || statSync(filePath).size < maxBytes) return false;
    const dir = dirname(filePath);
    const stamp = (options.now?.() ?? new Date()).toISOString().replace(/[:.]/g, "-");
    renameSync(filePath, join(dir, `${basename(filePath)}.${stamp}`));

    const prefix = shardPrefix(filePath);
    const archives = readdirSync(dir)
      .filter((name) => name.startsWith(prefix))
      .sort();
    for (const name of archives.slice(0, Math.max(0, archives.length - maxShards))) {
      try { rmSync(join(dir, name)); } catch { /* best-effort */ }
    }
    return true;
  } catch {
    // Rotation is a maintenance operation; never let it break the agent loop.
    return false;
  }
}
