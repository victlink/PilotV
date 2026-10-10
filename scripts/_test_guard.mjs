/**
 * 验收脚本的「别写进真库」护栏（Node 版）。
 *
 * 为什么要有 Node 版：_test_guard.py 只护住了 Python 脚本，
 * 而真正会往库里灌成果的 verify_mcp.mjs（publish_artifact）
 * 和 verify_gestures.mjs（POST 4 个成果）全是 Node 的 —— 手动单跑一次
 * 就是几百条 shot.png 进正式库。规则必须和 Python 版一字不差。
 *
 * 判据一样：问服务自己在用哪个数据目录，不是隔离的就不许写。
 */

/** 数据目录名里出现这些词，就算测试环境。 */
const TEST_MARKERS = ["test", "regress", "tmp", "ci-", "verify"];
/** 只有这些根目录下的，才明确是临时的。 */
const TMP_ROOTS = ["/tmp", "/var/tmp", "/private/tmp"];

export class NotATestServer extends Error {}

export function looksLikeTestDir(dataDir) {
  const d = String(dataDir || "");
  const abs = d.startsWith("/") ? d : `/${d}`;
  const low = abs.toLowerCase();
  if (TMP_ROOTS.some((r) => abs === r || abs.startsWith(r + "/"))) return true;
  return TEST_MARKERS.some((m) => low.includes(m));
}

/** 问服务它的数据目录。问不到抛错（交给调用方决定怎么办）。 */
export async function serverDataDir(api, token, timeoutMs = 5000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const headers = token ? { Authorization: `Bearer ${token}` } : {};
    const resp = await fetch(`${api.replace(/\/$/, "")}/api/artifacts/health`, {
      headers,
      signal: ctrl.signal,
    });
    const body = await resp.json();
    return String(body.data_dir || "");
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 确认 api 指向的是隔离测试服务，否则抛 NotATestServer。
 * @returns {Promise<string>} 该服务的数据目录
 */
export async function assertTestServer(api, token, { force = false } = {}) {
  let dataDir;
  try {
    dataDir = await serverDataDir(api, token);
  } catch (e) {
    throw new NotATestServer(`连不上 ${api} 的成果台（${e.message || e}）`);
  }
  if (force || looksLikeTestDir(dataDir)) return dataDir;
  throw new NotATestServer(
    `${api} 用的是正式数据目录 ${dataDir}，不是测试目录。\n` +
      `    往这里跑验收会把测试成果写进你的正式库（左栏被淹没就是这么来的）。\n` +
      `    两种做法：\n` +
      `      1) 用隔离环境：bash scripts/run_all_verify.sh\n` +
      `      2) 自己起一个：ARTIFACTS_DATA_DIR=/tmp/arts-verify ` +
      `python3 scripts/serve_test.py --port 8899\n` +
      `    确实就是要往正式库里写，加 --force。`,
  );
}