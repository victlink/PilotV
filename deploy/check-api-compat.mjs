#!/usr/bin/env node
// Static API compatibility gate.
//
// Why this exists: on 2026-11-11 the shipped frontend called
// GET /api/project-team/session-execution-mode, but the backend running on the
// device was an older fork without that route. The 404 made the composer's
// `executionReady` false forever and the send button stayed grey. A build/test
// green CI did not catch it because front and back were never compared.
//
// This gate answers: "for every /api/* path the frontend can call, is there a
// route in the vendored backend (or a documented non-backend owner)?"
//
//   node deploy/check-api-compat.mjs             # human readable, exit 1 on drift
//   node deploy/check-api-compat.mjs --json     # machine readable
//
// Zero dependencies, uses only node builtins, so it runs in the hygiene job.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const UP = path.join(ROOT, 'pilotdeck-mobile', 'upstream-official');
const UI_SRC = path.join(UP, 'ui', 'src');
const SERVER = path.join(UP, 'ui', 'server');
const INDEX = path.join(SERVER, 'index.js');
const GATEWAY = path.join(ROOT, 'service', 'pilotv_gateway.mjs');
const ALLOWLIST = path.join(HERE, 'api-compat-allowlist.json');
const JSON_OUT = process.argv.includes('--json');

const SRC_EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.mts']);
const SKIP_DIR = new Set(['node_modules', 'dist', '.git', 'e2e', '__snapshots__']);

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || SKIP_DIR.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (SRC_EXT.has(path.extname(entry.name))) out.push(full);
  }
  return out;
}

function normalize(input) {
  let p = String(input);
  // A `${...}` that starts a whole path segment is a parameter slot. One that
  // is glued onto a segment (e.g. `status${query}`) is a suffix/query builder:
  // drop it, the base path is what has to exist on the backend.
  p = p.replace(/(^|\/)\$\{[^}]*\}/g, '$1:param');
  p = p.replace(/\$\{[^}]*\}/g, '');
  // Unterminated template expressions happen when the literal itself contains
  // nested quotes/backticks; everything after them is not part of the path.
  p = p.replace(/\$\{[\s\S]*$/, '');
  p = p.split('?')[0].split('#')[0];
  p = p.replace(/:[A-Za-z_$][\w$]*/g, ':param');
  p = p.replace(/\/+/g, '/');
  if (p.length > 1) p = p.replace(/\/$/, '');
  return p;
}

function segments(p) {
  return normalize(p).split('/').filter(Boolean);
}

function matches(front, patterns) {
  const fs_ = segments(front);
  for (const candidate of patterns) {
    const norm = normalize(candidate);
    if (norm.endsWith('/*') || norm.includes('*')) {
      const base = segments(norm.replace(/\/\*.*$/, ''));
      if (fs_.length >= base.length && base.every((s, i) => s === fs_[i] || s === ':param' || s === '*')) return candidate;
      continue;
    }
    const ps = segments(norm);
    if (ps.length !== fs_.length) continue;
    let ok = true;
    for (let i = 0; i < ps.length; i += 1) {
      if (ps[i] === fs_[i]) continue;
      if (ps[i] === ':param' || ps[i] === '*') continue;
      // A frontend `:param` may be an enum whose backend route is a literal
      // (e.g. /api/gateway/${channel}/test -> /api/gateway/feishu/test).
      // The implementation exists in that slot, so accept it.
      if (fs_[i] === ':param' || fs_[i] === '*') continue;
      ok = false;
      break;
    }
    if (ok) return candidate;
  }
  return null;
}

// ---- 1. frontend API literals ----------------------------------------------
// Three separate patterns: a template literal may contain single/double quotes
// (e.g. `${q ? '?x' : ''}`) which a single "any quote" regex would truncate.
const LITERALS = [
  /'(\/api\/[^'\r\n]*)'/g,
  /"(\/api\/[^"\r\n]*)"/g,
  /`(\/api\/[^`\r\n]*)`/g,
];
const frontend = new Map(); // normalized path -> Set(file:line)
for (const file of walk(UI_SRC)) {
  // Test fixtures build fake /api paths with string concatenation; they are
  // not shipped API contracts. Only production frontend sources are gated.
  if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(file) || file.includes(`${path.sep}__tests__${path.sep}`)) continue;
  const text = fs.readFileSync(file, 'utf8');
  for (const re of LITERALS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      const norm = normalize(m[1]);
      if (norm === '/api' || norm === '') continue;
      const line = text.slice(0, m.index).split('\n').length;
      if (!frontend.has(norm)) frontend.set(norm, new Set());
      frontend.get(norm).add(`${path.relative(ROOT, file).replace(/\\/g, '/')}:${line}`);
    }
  }
}

// ---- 2. backend routes ------------------------------------------------------
const indexSrc = fs.readFileSync(INDEX, 'utf8');

// identifier -> local module file, from `import ... from './routes/x.js'`
function parseImports(source, sourceFile) {
  const map = new Map();
  const re = /import\s+([\s\S]*?)\s+from\s+['"]([^'"]+\.js)['"]/g;
  let m;
  while ((m = re.exec(source)) !== null) {
    if (!m[2].startsWith('.')) continue;
    const moduleFile = path.resolve(path.dirname(sourceFile), m[2]);
    const clause = m[1].replace(/[\s{}]/g, ' ');
    for (const word of clause.split(/[,\s]+/)) {
      if (!/^[A-Za-z_$][\w$]*$/.test(word) || word === 'as' || word === 'type') continue;
      map.set(word, moduleFile);
    }
  }
  return map;
}

const identifierToModule = parseImports(indexSrc, INDEX);
const ROUTE_VERB = /router\.(?:get|post|put|patch|delete|all|route|use)\(\s*['"`]([^'"`]*)['"`]/g;

// Routers can be composed: `routes/update.js` does
// `router.use(createWebUpdateRouter())`, and /api/update/info lives in
// webUpdate.js. Without following that composition the gate reports a real
// route as missing -- exactly the false positive we hit on 2026-11-11.
function collectRoutePaths(file, seen = new Set(), depth = 0) {
  if (depth > 3 || seen.has(file) || !fs.existsSync(file)) return [];
  seen.add(file);
  const src = fs.readFileSync(file, 'utf8');
  const paths = [];
  let m;
  ROUTE_VERB.lastIndex = 0;
  while ((m = ROUTE_VERB.exec(src)) !== null) {
    if (m[1].startsWith('/') || m[1] === '' || m[1].startsWith(':')) paths.push(m[1]);
  }
  const imports = parseImports(src, file);
  const composed = /router\.use\(\s*([A-Za-z_$][\w$]*)\s*\(/g;
  while ((m = composed.exec(src)) !== null) {
    const nested = imports.get(m[1]);
    if (nested) paths.push(...collectRoutePaths(nested, seen, depth + 1));
  }
  return paths;
}

const routeFiles = new Set();
const mounts = []; // { prefix, modules }
for (const re of [/\.use\(/g, /\.(get|post|put|patch|delete|all)\(/g]) {
  let m;
  while ((m = re.exec(indexSrc)) !== null) {
    // Only `app.use` / `app.get` etc, not `router.use` inside index.js (rare).
    const before = indexSrc.slice(Math.max(0, m.index - 8), m.index);
    if (!/\bapp$/.test(before.trim())) continue;
    // Only the leading arguments on the registration line matter. Balancing
    // the whole handler body is fragile (regex literals and nested template
    // strings confuse a paren counter), and a multi-line window would wrongly
    // associate identifiers from the NEXT mount with this prefix.
    const argStart = m.index + m[0].length;
    const lineEnd = indexSrc.indexOf('\n', argStart);
    const args = indexSrc.slice(argStart, Math.min(lineEnd === -1 ? argStart + 400 : lineEnd, argStart + 400));
    const first = args.match(/^\s*['"`]([^'"`]*)['"`]/);
    if (!first) continue;
    const prefix = first[1];
    if (!prefix.startsWith('/api')) continue;
    if (re.source.includes('use') && prefix === '/api') continue; // middleware
    const ids = args.match(/[A-Za-z_$][\w$]*/g) || [];
    const mods = [...new Set(ids.map((id) => identifierToModule.get(id)).filter(Boolean))];
    if (re.source.includes('use')) mounts.push({ prefix, modules: mods });
    else mounts.push({ prefix, modules: [], direct: true });
    for (const mod of mods) routeFiles.add(mod);
  }
}

const backendPatterns = new Set();
for (const mount of mounts) {
  backendPatterns.add(normalize(mount.prefix));
  for (const mod of mount.modules) {
    for (const sub of collectRoutePaths(mod)) {
      backendPatterns.add(normalize(`${mount.prefix}/${sub}`.replace(/\/+/g, '/')));
    }
  }
}

// Final safety net: if index.js mounting ever changes shape beyond what the
// parser understands, still enumerate route declarations from the whole server
// tree so a missing implementation cannot be silently waved through. These are
// prefix-less patterns and only match a frontend path in degenerate cases.
for (const file of walk(path.join(SERVER, 'routes'))) {
  for (const sub of collectRoutePaths(file)) {
    if (sub.startsWith('/')) backendPatterns.add(normalize(sub));
  }
}

if (process.env.API_COMPAT_DEBUG) {
  console.log('DEBUG mounts:', mounts.length, 'route files:', routeFiles.size);
  console.log('DEBUG rename patterns:', [...backendPatterns].filter((p) => p.includes('rename')));
  console.log('DEBUG office patterns:', [...backendPatterns].filter((p) => p.includes('office-preview')));
  console.log('DEBUG update patterns:', [...backendPatterns].filter((p) => p.startsWith('/api/update')));
}

// ---- 3. non-backend owners --------------------------------------------------
// The gateway routes /api/artifacts* to the (also in-repo) artifacts service
// and handles /api/pilotv/* itself. Fail loudly if that contract disappears.
const gatewaySrc = fs.existsSync(GATEWAY) ? fs.readFileSync(GATEWAY, 'utf8') : '';
const gatewayPrefixes = [];
if (gatewaySrc.includes("'/api/artifacts'") && gatewaySrc.includes("startsWith('/api/artifacts")) {
  gatewayPrefixes.push('/api/artifacts/*');
} else {
  console.error('FATAL: service/pilotv_gateway.mjs no longer declares the /api/artifacts routing contract.');
  process.exit(1);
}
if (gatewaySrc.includes("'/api/pilotv/'")) gatewayPrefixes.push('/api/pilotv/*');

const allowEntries = fs.existsSync(ALLOWLIST)
  ? JSON.parse(fs.readFileSync(ALLOWLIST, 'utf8')).entries || []
  : [];
const allowPatterns = allowEntries.map((e) => e.path);
function allowReason(p) {
  const exact = allowEntries.find((e) => normalize(e.path) === p);
  if (exact) return exact;
  const wildcard = allowEntries.find((e) => e.path.endsWith('/*') && matches(p, [e.path]));
  return wildcard || null;
}

// ---- 4. compare -------------------------------------------------------------
const critical = [
  '/api/project-team/session-execution-mode',
  '/api/settings/general-workspace',
];
const missingCritical = critical.filter((p) => !matches(p, backendPatterns));

const violations = [];
const covered = { backend: 0, gateway: 0, allowlist: 0 };
for (const [front, refs] of [...frontend.entries()].sort()) {
  if (matches(front, backendPatterns)) { covered.backend += 1; continue; }
  if (matches(front, gatewayPrefixes)) { covered.gateway += 1; continue; }
  const allowed = allowReason(front);
  if (allowed) { covered.allowlist += 1; continue; }
  violations.push({ path: front, refs: [...refs].slice(0, 4) });
}

const result = {
  ok: violations.length === 0 && missingCritical.length === 0,
  frontendApiPaths: frontend.size,
  backendRoutePatterns: backendPatterns.size,
  covered,
  missingCritical,
  violations,
};

if (JSON_OUT) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log(`API compat: ${result.frontendApiPaths} frontend /api paths vs ${result.backendRoutePatterns} vendored backend route patterns`);
  console.log(`  covered by backend: ${covered.backend}`);
  console.log(`  owned by gateway/artifacts: ${covered.gateway}`);
  console.log(`  allowlisted: ${covered.allowlist}`);
  const gaps = allowEntries.filter((e) => e.knownGap);
  if (gaps.length) {
    console.log(`  KNOWN GAPS (${gaps.length}) - allowlisted defects, NOT fixed by this gate:`);
    for (const g of gaps) console.log(`    ! ${g.path} -- ${g.reason}`);
  }
  if (missingCritical.length) {
    console.log('  MISSING CRITICAL ROUTES (these disable the composer when absent):');
    for (const p of missingCritical) console.log(`    - ${p}`);
  }
  if (violations.length) {
    console.log(`  UNMATCHED (${violations.length}):`);
    for (const v of violations) {
      console.log(`    - ${v.path}`);
      for (const r of v.refs) console.log(`        ${r}`);
    }
    console.log('  Fix: add the route to the vendored backend in the SAME PR as the frontend call,');
    console.log('  or add a justified entry to deploy/api-compat-allowlist.json.');
  } else {
    console.log('  OK: every frontend API path has an in-repo owner.');
  }
}

process.exit(result.ok ? 0 : 1);
