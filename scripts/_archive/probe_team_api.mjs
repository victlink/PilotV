/**
 * 只读：直接查 live 后端 (3001) 与 gateway (5187) 的 project-team 接口。
 */
import { createRequire } from 'node:module';

const require = createRequire('/home/Marc/PilotDeck-src/ui/package.json');
const Database = require('better-sqlite3');
const jwt = require('jsonwebtoken');

const db = new Database('/home/Marc/.pilotdeck/auth.db', { readonly: true });
const row = db.prepare('select value from app_config where key = ?').get('jwt_secret');
db.close();
const token = jwt.sign({ userId: 1, username: 'Marc' }, row.value, { expiresIn: '2h' });

const roots = [
    '/vol3/1000/Work/00/PilotV',
    '/home/Marc/pilotv-accept-20261104',
    '/home/Marc/general',
];
const bases = ['http://127.0.0.1:5187', 'http://127.0.0.1:3001'];

for (const base of bases) {
    console.log(`\n######## ${base} ########`);
    for (const root of roots) {
        const url = `${base}/api/project-team?projectRoot=${encodeURIComponent(root)}`;
        try {
            const res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, 'X-UI-Token': token } });
            const text = await res.text();
            let brief = text.slice(0, 300);
            try {
                const j = JSON.parse(text);
                const agents = j?.agents ?? j?.config?.agents ?? [];
                brief = `status=${res.status} agents=${agents.length} ` + JSON.stringify(agents.map((a) => ({ id: a.id, name: a.name, role: a.role, enabled: a.enabled })));
            } catch {}
            console.log(`  ${root} -> ${brief}`);
        } catch (e) {
            console.log(`  ${root} -> ERROR ${String(e).slice(0, 120)}`);
        }
    }
}
