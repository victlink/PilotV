import fs from 'node:fs';
import path from 'node:path';

const liveRoot = path.resolve('../../../../../home/Marc/PilotDeck-src');
const liveIndex = path.join(liveRoot, 'ui/server/index.js');
const liveBrowse = path.join(liveRoot, 'ui/server/utils/browseDirectories.js');
const vendoredIndex = path.resolve('pilotdeck-mobile/upstream-official/ui/server/index.js');
const vendoredBrowse = path.resolve('pilotdeck-mobile/upstream-official/ui/server/utils/browseDirectories.js');
const backupDir = path.resolve('.pilotdeck/work/reviewer-live-backup');
fs.mkdirSync(backupDir, { recursive: true });
for (const file of [liveIndex, liveBrowse]) fs.copyFileSync(file, path.join(backupDir, path.basename(file)));

let s = fs.readFileSync(liveIndex, 'utf8');
const requireOnce = (needle, replacement, label) => {
  if (!s.includes(needle)) throw new Error(`missing ${label}`);
  s = s.replace(needle, replacement);
};
requireOnce("import { createNormalizedMessage, createOptimisticUserFrames } from './pilotdeck-message.js';\n", "import { createNormalizedMessage, createOptimisticUserFrames } from './pilotdeck-message.js';\nimport { handlePendingPermissionsMessage, trackPermissionFrames } from './pending-permissions.js';\n", 'pending import');
requireOnce("            if (data.type === 'ping') return;", "            if (data.type === 'ping') {\n                try { ws.send(JSON.stringify({ type: 'pong', ts: data.ts ?? null })); } catch {}\n                return;\n            }", 'ping handler');
requireOnce("            } else if (data.type === 'get-pending-permissions') {\n                // Pending-permission introspection is gateway-internal. The\n                // permission_request event already contains everything the\n                // UI needs, so the response is now an empty stub.\n                writer.send({\n                    type: 'pending-permissions-response',\n                    sessionId: data.sessionId,\n                    data: [],\n                });", "            } else if (data.type === 'get-pending-permissions' || data.type === 'get-all-pending-permissions') {\n                handlePendingPermissionsMessage(data, writer);", 'pending handler');
requireOnce("    ws.on('error', () => {\n        cleanup();\n    });\n}", "    ws.on('error', () => {\n        cleanup();\n    });\n\n    ws.isAlive = true;\n    ws.on('pong', () => { ws.isAlive = true; });\n    const heartbeat = setInterval(() => {\n        if (ws.isAlive === false) { cleanup(); try { ws.terminate(); } catch {} return; }\n        ws.isAlive = false;\n        try { ws.ping(); } catch {}\n    }, 30000);\n    ws.on('close', () => clearInterval(heartbeat));\n}", 'server heartbeat');
const browseOld = "        const directories = await browseDirectories(resolvedPath, req.query.showHidden === 'true');";
requireOnce(browseOld, "        const entries = await browseDirectories(resolvedPath, req.query.showHidden === 'true', req.query.includeFiles === 'true');\n        const directories = entries.filter(entry => entry.type === 'directory');", 'browse entries');
requireOnce("            path: resolvedPath,\n            suggestions: suggestions,\n            ...(process.platform === 'win32' ? { rootsPath: '/' } : {}),", "            path: resolvedPath,\n            suggestions: suggestions,\n            ...(req.query.includeFiles === 'true' ? { entries } : {}),\n            ...(process.platform === 'win32' ? { rootsPath: '/' } : {}),", 'browse response');
fs.writeFileSync(liveIndex, s);
fs.copyFileSync(vendoredBrowse, liveBrowse);
console.log(JSON.stringify({ liveIndex, liveBrowse, backupDir }));
