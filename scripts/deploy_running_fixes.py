#!/usr/bin/env python3
"""Deploy already-reviewed fixes without touching auth, data or other source changes."""
import datetime, json, os, pathlib, shutil, subprocess, sys
ROOT = pathlib.Path(__file__).resolve().parents[1]
os.chdir(ROOT)
UI = ROOT / 'pilotdeck-mobile/upstream-official/ui'
RUNTIME = ROOT.parent / '.pilotdeck/app/ui'
ART = ROOT.parent / 'pilotv-artifacts'
STATE = ROOT / 'scripts/.deploy_running_fixes_state.json'
def run(args, **kw):
    return subprocess.run(args, check=True, **kw)
mode = sys.argv[1]
if mode == 'prepare':
    stamp = datetime.datetime.now().strftime('%Y%m%d-%H%M%S')
    backup = ROOT / '.deployment-backups' / stamp
    backup.mkdir(parents=True, mode=0o700)
    for rel in ['server/index.js', 'server/utils/browseDirectories.js']:
        dst = backup / 'runtime' / rel
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(RUNTIME / rel, dst)
    (backup / 'artifacts').mkdir()
    for name in ['artifacts_console.py', 'pilotdeck_workspace.py']:
        shutil.copy2(ART / name, backup / 'artifacts' / name)
    if (UI / 'dist').exists():
        shutil.copytree(UI / 'dist', backup / 'dist')
    patch = subprocess.check_output(['git', 'diff', '--relative=pilotdeck-mobile/upstream-official/ui', '--', str(UI / 'server/index.js'), str(UI / 'server/utils/browseDirectories.js')])
    assert patch and b'/src/' not in patch
    (backup / 'backend.patch').write_bytes(patch)
    run(['patch', '--dry-run', '--batch', '-p1', '-d', str(RUNTIME)], input=patch)
    STATE.write_text(json.dumps({'backup': str(backup)}, indent=2))
    print('BACKUP', backup, flush=True)
elif mode == 'install':
    backup = pathlib.Path(json.loads(STATE.read_text())['backup'])
    assert (UI / 'dist.deploy/index.html').is_file()
    patch = (backup / 'backend.patch').read_bytes()
    run(['patch', '--dry-run', '--batch', '-p1', '-d', str(RUNTIME)], input=patch)
    for rel in ['server/index.js', 'server/utils/browseDirectories.js']:
        assert (RUNTIME / rel).read_bytes() == (backup / 'runtime' / rel).read_bytes(), 'Runtime changed since backup'
    run(['patch', '--batch', '--no-backup-if-mismatch', '-p1', '-d', str(RUNTIME)], input=patch)
    for rel in ['server/index.js', 'server/utils/browseDirectories.js']:
        run(['node', '--check', str(RUNTIME / rel)])
    for name in ['artifacts_console.py', 'pilotdeck_workspace.py']:
        compile((ROOT / name).read_text(), name, 'exec')
        shutil.copy2(ROOT / name, ART / (name + '.deploy'))
        os.replace(ART / (name + '.deploy'), ART / name)
    if (UI / 'dist').exists():
        os.rename(UI / 'dist', UI / ('dist.previous-' + backup.name))
    os.rename(UI / 'dist.deploy', UI / 'dist')
    run(['systemctl', '--user', 'restart', 'pilotv-artifacts.service'])
    print('INSTALLED; backend pending controlled restart; backup', backup, flush=True)
else:
    raise SystemExit('prepare or install required')
