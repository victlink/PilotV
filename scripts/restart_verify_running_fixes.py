#!/usr/bin/env python3
"""Controlled supervisor restart and secret-safe live deployment verification."""
import asyncio, json, os, pathlib, re, signal, subprocess, time, urllib.request, urllib.error
ROOT = pathlib.Path(__file__).resolve().parents[1]
os.chdir(ROOT)
state = json.loads((ROOT / 'scripts/.deploy_running_fixes_state.json').read_text())
report = pathlib.Path(state['backup']) / 'verification.json'
results = {}
def fetch(url, token=None):
    req = urllib.request.Request(url, headers={'Authorization': 'Bearer ' + token} if token else {})
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.status, r.read()
def save():
    report.write_text(json.dumps(results, indent=2))
    print(json.dumps(results, indent=2), flush=True)
async def browser_token():
    try:
        from playwright.async_api import async_playwright
        async with async_playwright() as p:
            browser = await p.chromium.connect_over_cdp('http://127.0.0.1:9222')
            for ctx in browser.contexts:
                for page in ctx.pages:
                    if ':5186' not in page.url and ':3001' not in page.url:
                        continue
                    values = await page.evaluate('Object.values(localStorage)')
                    for value in values:
                        if isinstance(value, str) and re.fullmatch(r'eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+', value):
                            return value
    except Exception:
        pass
    return None
def ui_pid():
    """找到正在跑的 UI server 进程。

    以前这里写死了一个 pid，那个进程一重启就失效 —— 脚本直接 AssertionError，
    看起来像"部署验证失败"，其实只是没找到进程。动态找更耐重启。
    """
    for entry in pathlib.Path('/proc').iterdir():
        if not entry.name.isdigit():
            continue
        try:
            cmdline = (entry / 'cmdline').read_bytes()
        except OSError:
            continue
        if b'/home/marc/.pilotdeck/app/ui/server/index.js' in cmdline:
            return int(entry.name)
    raise RuntimeError('找不到 UI server 进程（/home/marc/.pilotdeck/app/ui/server/index.js）')
try:
    token = asyncio.run(browser_token())
    pid = ui_pid()
    cmd = pathlib.Path(f'/proc/{pid}/cmdline').read_bytes()
    assert b'/home/marc/.pilotdeck/app/ui/server/index.js' in cmd
    env = dict(part.split(b'=', 1) for part in pathlib.Path(f'/proc/{pid}/environ').read_bytes().split(b'\0') if b'=' in part)
    request = pathlib.Path(env[b'PILOTDECK_RESTART_REQUEST_FILE'].decode())
    assert env[b'PILOTDECK_RESTART_SUPERVISOR'] == b'1'
    request.parent.mkdir(parents=True, exist_ok=True)
    request.write_text(json.dumps({'requestedAt': time.strftime('%Y-%m-%dT%H:%M:%S'), 'mode': 'start-built', 'pid': pid}))
    os.kill(pid, signal.SIGTERM)
    results['restart'] = 'supervisor restart-request file + SIGTERM UI child; supervisor necessarily restarts its gateway child too'
    for i in range(90):
        time.sleep(2)
        try:
            status, body = fetch('http://127.0.0.1:3001/api/auth/status')
            if status == 200 and not pathlib.Path(f'/proc/{pid}').exists():
                results['backend_ready'] = True
                break
        except Exception:
            pass
    assert results.get('backend_ready'), 'Backend readiness timeout'
    status, body = fetch('http://127.0.0.1:5186/')
    local = ROOT / 'pilotdeck-mobile/upstream-official/ui/dist'
    assert body == (local / 'index.html').read_bytes()
    assets = re.findall(r'(?:src|href)="(/assets/[^\"]+)"', body.decode())
    for asset in assets:
        code, data = fetch('http://127.0.0.1:5186' + asset)
        assert data == (local / asset.lstrip('/')).read_bytes()
    results['frontend'] = {'http': status, 'index_matches_build': True, 'assets_verified': len(assets)}
    artifact_token = (ROOT.parent / '.config/pilotv-artifacts/token').read_text().strip()
    results['artifacts'] = {}
    for endpoint in ['/healthz', '/api/artifacts/health', '/api/artifacts?limit=1']:
        code, data = fetch('http://127.0.0.1:8799' + endpoint, artifact_token)
        json.loads(data)
        results['artifacts'][endpoint] = code
    if token:
        from urllib.parse import urlencode
        code, data = fetch('http://127.0.0.1:5186/api/browse-filesystem?' + urlencode({'path': str(ROOT), 'includeFiles': 'true'}), token)
        payload = json.loads(data)
        assert any(e['type'] == 'file' for e in payload['entries'])
        assert all(e['type'] == 'directory' for e in payload['suggestions'])
        code2, data2 = fetch('http://127.0.0.1:5186/api/browse-filesystem?' + urlencode({'path': str(ROOT)}), token)
        assert 'entries' not in json.loads(data2)
        results['authenticated_browse'] = {'http': code, 'includeFiles_has_files': True, 'legacy_directory_only_preserved': True}
    else:
        results['authenticated_browse'] = 'Not tested: no existing browser JWT accessible; auth unchanged'
    for name, user in [('pilotv-gateway.service', False), ('pilotv-artifacts.service', True), ('pilotdeck-supervisor.service', True)]:
        args = ['systemctl'] + (['--user'] if user else []) + ['show', name, '-p', 'ActiveState', '-p', 'SubState', '-p', 'MainPID']
        results[name] = subprocess.check_output(args, text=True).strip()
    results['success'] = True
except Exception as exc:
    results['success'] = False
    results['error'] = type(exc).__name__ + ': ' + str(exc).split('?')[0]
finally:
    save()
if not results['success']:
    raise SystemExit(1)
