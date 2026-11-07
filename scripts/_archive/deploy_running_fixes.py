#!/usr/bin/env python3
"""Deploy already-reviewed fixes without touching auth, data or other source changes."""
import datetime, json, os, pathlib, shutil, subprocess, sys
ROOT = pathlib.Path(__file__).resolve().parents[1]
os.chdir(ROOT)
UI = ROOT / 'pilotdeck-mobile/upstream-official/ui'
RUNTIME = ROOT.parent / '.pilotdeck/app/ui'
ART = ROOT.parent / 'pilotv-artifacts'
STATE = ROOT / 'scripts/.deploy_running_fixes_state.json'
PATCHED = ['server/index.js', 'server/utils/browseDirectories.js']
# 静态资源（sw.js / manifest.json / icons / brand）不走 git diff 补丁：
# 运行时目录里的这些文件本来就该和仓库一致，直接整份覆盖最省事，
# 也避免「补丁打不上 → 整个部署失败」。
PUBLIC = UI / 'public'
PUBLIC_RUNTIME = RUNTIME / 'public'
def run(args, **kw):
    return subprocess.run(args, check=True, **kw)
def restart_service(name):
    """重启用户级 unit。

    没有 user bus 的 shell 里 systemctl --user 必然失败，这在 CI/无登录会话里
    是常态，不该把已经完成的部署拖成失败。返回是否真的重启了。
    """
    proc = subprocess.run(['systemctl', '--user', 'restart', name], capture_output=True, text=True)
    if proc.returncode != 0:
        detail = [x for x in (proc.stderr or proc.stdout or '').splitlines() if x.strip()]
        print('WARN: systemctl --user restart %s 未执行（%s）' % (name, detail[-1] if detail else 'unknown'), flush=True)
        return False
    return True
def sync_public():
    """把仓库的 public/ 同步到运行时目录。

    服务端注册静态中间件的顺序是 ../public 在前、../dist 在后，
    所以 /sw.js、/manifest.json、/icons/* 实际是从 public/ 读的，
    dist/ 里那份永远不会被命中。以前部署只 patch server/*.js、
    只换 dist/，public/ 一直停在旧版本（sw.js 停在 v2，离线兜底没上线）。
    只覆盖同名文件，运行目录里独有的文件保留。
    """
    shutil.copytree(PUBLIC, PUBLIC_RUNTIME, dirs_exist_ok=True)
    print('PUBLIC synced -> %s' % PUBLIC_RUNTIME, flush=True)
def git(*args):
    return subprocess.check_output(['git', *args], text=True).strip()
def load_state():
    try:
        return json.loads(STATE.read_text())
    except Exception:
        return {}
def backend_patch(base):
    """vendored 副本相对「已部署基线」的差异。

    基线是上一次 install 成功时记录的 commit，所以已提交和未提交的改动
    都能带上。早先这里直接用 git diff（工作区 vs 暂存区），一旦改动被提交
    就没有补丁可生成，脚本会卡在 assert 上。
    """
    return subprocess.check_output(
        ['git', 'diff', base, '--relative=pilotdeck-mobile/upstream-official/ui', '--',
         str(UI / 'server/index.js'), str(UI / 'server/utils/browseDirectories.js')])
def apply_patch(patch, dry_run):
    """把补丁打到运行时目录。

    必须带 --forward：GNU patch 发现「补丁已应用」时，默认会自动反向应用
    （Reversed (or previously applied) patch detected! Assuming -R.），
    那会把已经部署到运行时的修复悄悄撤掉。--forward 让它跳过而不是反向。
    全部 hunk 都被跳过时 patch 返回 1，这在「运行时已经是最新」时属于正常。
    """
    if not patch.strip():
        return '无后端补丁（基线之后没有改动）'
    args = ['patch', '--batch', '--forward', '-p1', '-d', str(RUNTIME)]
    if dry_run:
        args.insert(1, '--dry-run')
    proc = subprocess.run(args, input=patch.decode('utf-8', 'surrogateescape'), capture_output=True, text=True)
    out = (proc.stdout + proc.stderr).strip()
    # patch 跳过已应用的 hunk 时会丢一个 .rej 到运行时目录，别把垃圾留在那儿
    for rej in RUNTIME.rglob('*.rej'):
        rej.unlink()
        print('REMOVED', rej, flush=True)
    if proc.returncode != 0:
        if 'FAILED' in out:
            raise SystemExit(f'patch 冲突:\n{out}')
        if 'hunks ignored' in out:
            return f'已应用（{out.splitlines()[-1]}）'
        raise SystemExit(f'patch 失败({proc.returncode}):\n{out}')
    return out or 'OK'
mode = sys.argv[1]
if mode == 'prepare':
    stamp = datetime.datetime.now().strftime('%Y%m%d-%H%M%S')
    backup = ROOT / '.deployment-backups' / stamp
    backup.mkdir(parents=True, mode=0o700, exist_ok=True)
    for rel in PATCHED:
        dst = backup / 'runtime' / rel
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(RUNTIME / rel, dst)
    # 运行时 public/ 和 dist/ 是这次要整体替换掉的东西，必须留一份能回滚的副本。
    if (PUBLIC_RUNTIME).exists():
        shutil.copytree(PUBLIC_RUNTIME, backup / 'runtime-public', dirs_exist_ok=True)
    if (RUNTIME / 'dist').exists():
        shutil.copytree(RUNTIME / 'dist', backup / 'runtime-dist', dirs_exist_ok=True)
    (backup / 'artifacts').mkdir()
    for name in ['artifacts_console.py', 'pilotdeck_workspace.py']:
        shutil.copy2(ART / name, backup / 'artifacts' / name)
    if (UI / 'dist').exists():
        shutil.copytree(UI / 'dist', backup / 'dist')
    base = load_state().get('base') or git('rev-parse', 'HEAD')
    patch = backend_patch(base)
    assert b'/src/' not in patch
    (backup / 'backend.patch').write_bytes(patch)
    print('DRY-RUN', apply_patch(patch, dry_run=True), flush=True)
    STATE.write_text(json.dumps({'backup': str(backup), 'base': base}, indent=2))
    print('BACKUP', backup, flush=True)
elif mode == 'install':
    state = load_state()
    backup = pathlib.Path(state['backup'])
    assert (UI / 'dist.deploy/index.html').is_file()
    patch = (backup / 'backend.patch').read_bytes()
    print('DRY-RUN', apply_patch(patch, dry_run=True), flush=True)
    for rel in PATCHED:
        assert (RUNTIME / rel).read_bytes() == (backup / 'runtime' / rel).read_bytes(), 'Runtime changed since backup'
    print('APPLY', apply_patch(patch, dry_run=False), flush=True)
    for rel in PATCHED:
        run(['node', '--check', str(RUNTIME / rel)])
    sync_public()
    artifacts_changed = False
    for name in ['artifacts_console.py', 'pilotdeck_workspace.py']:
        compile((ROOT / name).read_text(), name, 'exec')
        target = ART / name
        if not target.exists() or target.read_bytes() != (ROOT / name).read_bytes():
            artifacts_changed = True
        shutil.copy2(ROOT / name, ART / (name + '.deploy'))
        os.replace(ART / (name + '.deploy'), ART / name)
    if (UI / 'dist').exists():
        os.rename(UI / 'dist', UI / ('dist.previous-' + backup.name))
    os.rename(UI / 'dist.deploy', UI / 'dist')
    if artifacts_changed and not restart_service('pilotv-artifacts.service'):
        raise SystemExit('成果台代码已更新，但 pilotv-artifacts 服务未能重启，新代码尚未生效')
    STATE.write_text(json.dumps({'backup': str(backup), 'base': git('rev-parse', 'HEAD')}, indent=2))
    print('INSTALLED; backend pending controlled restart; backup', backup, flush=True)
else:
    raise SystemExit('prepare or install required')
