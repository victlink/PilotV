// Runtime gate for the UI server, gateway CLI and install scripts.
//
// History: this used to require ">=22.13.0 and <23" (Node 22 only). On
// 2026-11-13 the Windows dev machine was moved to Node 24.22.3 LTS because
// Node 22.22.2 kept hitting the V8 cppgc assertion
// `Check failed: marking_done_` when two long-context commander loops ran
// concurrently (see docs/COMMANDER-LOOP.md §12). Node 24 still ships
// node:sqlite, so the gate now accepts the 22 and 24 LTS lines.
//
// ABI-bound native packages (better-sqlite3 in particular) must be rebuilt or
// replaced with a matching prebuild when the major version changes.

const minimumNodeVersion = [22, 13, 0];
const minimumNodeVersionLabel = "22.13.0";
const supportedNodeMajors = [22, 24];
const maximumNodeVersionLabel = "25";
const nodeVersionRequirementLabel = `>=${minimumNodeVersionLabel} and <${maximumNodeVersionLabel} (Node.js 22 or 24 LTS)`;
const knownCppgcAffectedVersion = "22.22.2";

function parseNodeVersion(version) {
  return version
    .replace(/^v/, "")
    .split(".")
    .map((part) => Number.parseInt(part, 10) || 0);
}

function isAtLeastMinimum(version) {
  const current = parseNodeVersion(version);
  for (let index = 0; index < minimumNodeVersion.length; index += 1) {
    if ((current[index] ?? 0) > minimumNodeVersion[index]) return true;
    if ((current[index] ?? 0) < minimumNodeVersion[index]) return false;
  }
  return true;
}

function isSupportedMajor(version) {
  return supportedNodeMajors.includes(parseNodeVersion(version)[0] ?? 0);
}

function formatNodeVersion(version) {
  return version.startsWith("v") ? version : `v${version}`;
}

function fail(message) {
  console.error(`[pilotdeck] ${message}`);
  process.exit(1);
}

const emitWarning = process.emitWarning.bind(process);
process.emitWarning = (warning, typeOrOptions, ...args) => {
  const warningType = typeof typeOrOptions === "string" ? typeOrOptions : typeOrOptions?.type;
  const warningText = typeof warning === "string" ? warning : warning?.message;
  if (warningType === "ExperimentalWarning" && warningText?.includes("SQLite")) {
    return;
  }
  emitWarning(warning, typeOrOptions, ...args);
};

const testMode = process.env.PILOTDECK_RUNTIME_CHECK_TEST_MODE === "1";
const nodeVersion =
  testMode && process.env.PILOTDECK_TEST_NODE_VERSION
    ? process.env.PILOTDECK_TEST_NODE_VERSION
    : process.versions.node;
const skipSqliteCheck = testMode && process.env.PILOTDECK_TEST_SKIP_SQLITE === "1";

if (!isAtLeastMinimum(nodeVersion) || !isSupportedMajor(nodeVersion)) {
  fail(
    `Node.js ${nodeVersionRequirementLabel} is required because PilotV uses node:sqlite and ABI-bound native packages. Current: ${formatNodeVersion(nodeVersion)}. Use Node.js 22.13+ or 24 LTS and reinstall native dependencies (better-sqlite3 must match the Node ABI).`,
  );
}

if (nodeVersion === knownCppgcAffectedVersion) {
  console.warn(
    `[pilotdeck] WARN Node.js ${knownCppgcAffectedVersion} is known to crash with V8 "Check failed: marking_done_" under concurrent long-context turns; upgrade to Node.js 24 LTS. See docs/COMMANDER-LOOP.md §12.`,
  );
}

if (!skipSqliteCheck) {
  try {
    await import("node:sqlite");
  } catch {
    fail(
      `Current Node.js (${formatNodeVersion(nodeVersion)}) does not provide node:sqlite. Switch to Node.js ${minimumNodeVersionLabel}+ or 24 LTS and reinstall dependencies.`,
    );
  }
}
