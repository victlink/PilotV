#!/usr/bin/env python3
"""Single-record ownership repair. Default dry-run; --apply requires exact old state.
No content, version, timestamps, watcher mappings, or authentication changes.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import time
from datetime import datetime, timezone
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parents[1]
DB = ROOT.parent / 'pilotv-artifacts/data/artifacts.db'
AID = 'art_2948de'
OLD = 'web:s_cc2f881e-659b-43d7-8bce-fc354c1d15da'
NEW = 'web:s_c7f16104-1a22-464f-bc06-85f1d0296a87'
PROJECT = 'home-marc-.pilotdeck-app-ui-3D'
NAME = 'PilotV-Intro-3D-Redo-1080p.mp4'
SOURCE = ROOT / '常用资料/PilotV-Logo-3D/片头动画/重制版' / NAME
TRANSCRIPT = ROOT.parent / '.pilotdeck/projects' / PROJECT / 'chats' / (NEW + '.jsonl')
BASE = 'http://127.0.0.1:8799/api/artifacts'

def require(condition, message):
    if not condition:
        raise RuntimeError(message)

def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()

def get(path):
    with urlopen(BASE + path, timeout=30) as response:
        return response.status, response.read()

def locations(tree):
    found = []
    for project in tree['projects']:
        if any(a['id'] == AID for a in project.get('artifacts', [])):
            found.append([project['name'], None])
        for session in project.get('sessions', []):
            if any(a['id'] == AID for a in session.get('artifacts', [])):
                found.append([project['name'], session['id']])
    return found

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    os.umask(0o077)
    records = [json.loads(line) for line in TRANSCRIPT.read_text().splitlines()]
    evidence = [r for r in records if r.get('sequence') in (173, 174, 175, 176)
                and r.get('type') in ('assistant_message', 'tool_result_message')]
    by_seq = {r['sequence']: r for r in evidence}
    require(set(by_seq) == {173, 174, 175, 176}, 'Missing transcript evidence')
    require(all(r.get('sessionId') == NEW for r in evidence), 'Wrong transcript session')
    require(str(SOURCE) in json.dumps(by_seq[174], ensure_ascii=False), 'Missing exact download path')
    require('735904' in json.dumps(by_seq[173]), 'Missing size evidence')
    require(NAME in json.dumps(by_seq[176]), 'Missing final delivery')
    require('exitCode": 0' in json.dumps(by_seq[175]), 'Download did not succeed')
    conn = sqlite3.connect('file:' + str(DB) + '?mode=rw', uri=True, timeout=20)
    conn.row_factory = sqlite3.Row
    before = dict(conn.execute('SELECT * FROM artifacts WHERE id=?', (AID,)).fetchone())
    require(before['run_id'] == OLD and before['project'] == '', 'Ownership no longer matches guard; refusing')
    require(before['file_name'] == NAME and before['size'] == 735904 and before['kind'] == 'video', 'Wrong target content')
    require(json.loads(before['source_json'])['path'] == str(SOURCE), 'Wrong source')
    sha = digest(SOURCE)
    require(SOURCE.stat().st_size == 735904 and digest(before['stored_path']) == sha, 'Source/stored content mismatch')
    report = {'artifact_id': AID, 'before': before, 'proposed': {'run_id': NEW, 'project': PROJECT},
              'sha256': sha, 'transcript': str(TRANSCRIPT),
              'evidence': [{'sequence': r['sequence'], 'createdAt': r['createdAt'],
                            'content': r['message']['content'][0].get('input') or r['message']['content'][0].get('text') or r['message']['content'][0].get('content')}
                           for r in evidence]}
    print(json.dumps({'mode': 'apply' if args.apply else 'dry-run', 'artifact_id': AID,
                      'source_and_stored_sha256': sha, 'transcript_sequences': sorted(by_seq)}, ensure_ascii=False))
    if not args.apply:
        conn.close()
        return
    directory = ROOT / '.deployment-backups' / ('repair-art_2948de-' + datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ'))
    directory.mkdir(parents=True, exist_ok=False)
    report_path = directory / 'evidence.json'
    def save():
        report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    save()
    try:
        conn.execute('BEGIN IMMEDIATE')
        require(dict(conn.execute('SELECT * FROM artifacts WHERE id=?', (AID,)).fetchone()) == before, 'Record changed before lock')
        with sqlite3.connect('file:' + str(DB) + '?mode=ro', uri=True) as reader:
            with sqlite3.connect(directory / 'artifacts.db') as backup:
                reader.backup(backup)
                require(backup.execute('PRAGMA integrity_check').fetchone()[0] == 'ok', 'Invalid backup')
        watch_before = [tuple(r) for r in conn.execute('SELECT * FROM watch_sources ORDER BY path')]
        cursor = conn.execute('UPDATE artifacts SET run_id=?, project=? WHERE id=? AND run_id=? AND project=? AND file_name=? AND size=?',
                              (NEW, PROJECT, AID, OLD, '', NAME, 735904))
        require(cursor.rowcount == 1, 'Guarded UPDATE must affect exactly one record')
        after = dict(conn.execute('SELECT * FROM artifacts WHERE id=?', (AID,)).fetchone())
        require(after == dict(before, run_id=NEW, project=PROJECT), 'Unexpected non-ownership change')
        require(watch_before == [tuple(r) for r in conn.execute('SELECT * FROM watch_sources ORDER BY path')], 'Watcher mappings changed')
        # Compare the entire locked database against the backup: only these two fields may differ.
        with sqlite3.connect(directory / 'artifacts.db') as backup:
            for (table,) in backup.execute("SELECT name FROM sqlite_master WHERE type='table'"):
                require(table.replace('_', '').isalnum(), 'Unexpected table name')
                old_rows = backup.execute('SELECT * FROM "' + table + '" ORDER BY rowid').fetchall()
                new_rows = [tuple(r) for r in conn.execute('SELECT * FROM "' + table + '" ORDER BY rowid')]
                if table == 'artifacts':
                    columns = [r[1] for r in conn.execute('PRAGMA table_info(artifacts)')]
                    old_rows = [tuple(after[c] for c in columns) if r[columns.index('id')] == AID else r for r in old_rows]
                require(old_rows == new_rows, 'Unexpected database changes: ' + table)
        conn.commit()
        report.update({'committed': True, 'after': after, 'all_tables_verified_only_two_ownership_fields_changed': True,
                       'backup': str(directory / 'artifacts.db')})
        save()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()
    # Existing project-tree cache TTL is 15 seconds. No restart or auth changes.
    time.sleep(16)
    status, payload = get('/' + AID)
    detail = json.loads(payload)
    require(status == 200 and detail['run_id'] == NEW and detail['project'] == PROJECT, 'API detail mismatch')
    status, payload = get('/workspace?limit=2000')
    found = locations(json.loads(payload))
    require(status == 200 and found == [[PROJECT, NEW]], 'Workspace placement mismatch: ' + repr(found))
    status, video = get('/' + AID + '/raw')
    require(status == 200 and len(video) == 735904 and hashlib.sha256(video).hexdigest() == sha, 'Video GET mismatch')
    report['verification'] = {'detail_http': 200, 'workspace_http': 200, 'workspace_locations': found,
                              'wrong_session_absent': True, 'video_http': status, 'video_bytes': len(video),
                              'video_sha256': sha, 'source_unchanged': digest(SOURCE) == sha,
                              'stored_unchanged': digest(before['stored_path']) == sha}
    save()
    print(json.dumps({'evidence_file': str(report_path), 'verification': report['verification']}, ensure_ascii=False))

if __name__ == '__main__':
    main()
