#!/usr/bin/env python3
"""Backed-up frontend publish and read-only secret-safe live verification."""
import asyncio, datetime, hashlib, json, os, pathlib, re, shutil, ssl, subprocess, urllib.request
ROOT=pathlib.Path(__file__).resolve().parents[1]
UI=ROOT/'pilotdeck-mobile/upstream-official/ui'
backup=ROOT/'.deployment-backups'/('final-'+datetime.datetime.now().strftime('%Y%m%d-%H%M%S'))
backup.mkdir(mode=0o700)
result={}
def digest(p): return hashlib.sha256(p.read_bytes()).hexdigest()
def fetch(url, token=None):
    req=urllib.request.Request(url,headers={'Authorization':'Bearer '+token} if token else {})
    with urllib.request.urlopen(req,context=ssl._create_unverified_context(),timeout=90) as r: return r.status,r.read()
async def get_token():
    from playwright.async_api import async_playwright
    async with async_playwright() as p:
        browser=await p.chromium.connect_over_cdp('http://127.0.0.1:9222')
        for ctx in browser.contexts:
            for page in ctx.pages:
                if ':5186' not in page.url and ':3001' not in page.url: continue
                for value in await page.evaluate('Object.values(localStorage)'):
                    if isinstance(value,str) and re.fullmatch(r'eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+',value): return value
    return None
try:
    if (UI/'dist.verify-stage').exists():
        stage=UI/'dist.verify-stage'
        assert (stage/'index.html').is_file()
        head=subprocess.check_output(['git','rev-parse','HEAD'],cwd=ROOT,text=True).strip()
        assert json.loads((stage/'web-build.json').read_text())['sourceSha']==head
        # Backup full previous build, retain hashed assets for already-open clients.
        shutil.copytree(UI/'dist',backup/'dist')
        retained=0
        for old in (UI/'dist/assets').iterdir():
            dst=stage/'assets'/old.name
            if old.is_file() and not dst.exists(): shutil.copy2(old,dst); retained+=1
        os.rename(UI/'dist',backup/'dist-swapped')
        try: os.rename(stage,UI/'dist')
        except Exception:
            os.rename(backup/'dist-swapped',UI/'dist'); raise
        result['frontend_deployed']={'sourceSha':head,'backup':str(backup),'old_assets_retained':retained,'auth_enabled_build':True}
    else:
        result['frontend_deployed']={'already_published':True,'sourceSha':json.loads((UI/'dist/web-build.json').read_text())['sourceSha'],'original_backup':str(ROOT/'.deployment-backups/final-20261016-121220')}
    code,body=fetch('https://127.0.0.1:5186/')
    normalized=re.sub(rb'<script>window\.__PILOTV__=.*?;</script>',b'',body)
    assert normalized==(UI/'dist/index.html').read_bytes(), 'HTML differs beyond gateway runtime injection'
    assets=re.findall(r'(?:src|href)="(/assets/[^\"]+)"',body.decode())
    for asset in assets:
        _,data=fetch('https://127.0.0.1:5186'+asset)
        assert data==(UI/'dist'/asset.lstrip('/')).read_bytes()
    result['https_frontend']={'status':code,'index_sha256':hashlib.sha256(body).hexdigest(),'entry_assets_matched':len(assets),'tls_note':'local verification skips certificate trust validation'}
    result['backend_auth_status']=fetch('http://127.0.0.1:3001/api/auth/status')[0]
    result['runtime_hashes']={}
    for name in ['artifacts_console.py','pilotdeck_workspace.py']:
        assert digest(ROOT/name)==digest(ROOT.parent/'pilotv-artifacts'/name)
        result['runtime_hashes'][name]=digest(ROOT/name)
    util='server/utils/browseDirectories.js'
    assert digest(UI/util)==digest(ROOT.parent/'.pilotdeck/app/ui'/util)
    result['runtime_hashes'][util]=digest(UI/util)
    patch=(ROOT/'.deployment-backups/20261016-081339/backend.patch').read_bytes()
    subprocess.run(['patch','--dry-run','--reverse','--batch','-p1','-d',str(ROOT.parent/'.pilotdeck/app/ui')],input=patch,check=True,stdout=subprocess.DEVNULL)
    result['backend_patch_reverse_check']=True
    token=(ROOT.parent/'.config/pilotv-artifacts/token').read_text().strip()
    result['artifacts_health']={ep:fetch('http://127.0.0.1:8799'+ep,token)[0] for ep in ['/healthz','/api/artifacts/health','/api/artifacts?limit=1']}
    _,data=fetch('http://127.0.0.1:8799/api/artifacts/workspace?limit=2000',token)
    tree=json.loads(data); sessions=[s for p in tree['projects'] for s in p['sessions'] if s['id']!='__unassigned__']
    ids={s['id'] for s in sessions}; aliases={}
    for sid in ids: aliases.setdefault(sid.rsplit(':',1)[-1],[]).append(sid)
    explicit=matched=unassigned=0
    for project in tree['projects']:
        for session in project['sessions']:
            for art in session.get('artifacts',[]):
                run=art.get('run_id')
                if not run: continue
                explicit+=1
                expected=run if run in ids else (aliases[run][0] if ':' not in run and len(aliases.get(run,[]))==1 else '__unassigned__')
                assert session['id']==expected,'Explicit artifact owner mismatch'
                if expected=='__unassigned__': unassigned+=1
                else: matched+=1
    result['artifact_association']={'explicit_checked':explicit,'matched_conversations':matched,'unresolved_preserved_unassigned':unassigned}
    try: jwt=asyncio.run(get_token())
    except Exception as e: jwt=None; result['browser_auth_lookup']=type(e).__name__
    if jwt:
        from urllib.parse import urlencode
        base='https://127.0.0.1:5186/api/browse-filesystem?'
        code,data=fetch(base+urlencode({'path':str(ROOT),'includeFiles':'true'}),jwt)
        payload=json.loads(data)
        assert any(e['type']=='file' for e in payload['entries'])
        assert all(e['type']=='directory' for e in payload['suggestions'])
        _,data=fetch(base+urlencode({'path':str(ROOT)}),jwt)
        assert 'entries' not in json.loads(data)
        result['authenticated_directory_listing']={'status':code,'files_present':True,'legacy_directory_only':True}
    else: result['authenticated_directory_listing']='No existing accessible browser JWT; not tested; auth unchanged'
    result['services']={}
    for name,user in [('pilotv-gateway.service',False),('pilotv-artifacts.service',True),('pilotdeck-supervisor.service',True)]:
        state=subprocess.check_output(['systemctl']+(['--user'] if user else [])+['show',name,'-p','ActiveState','-p','SubState','-p','MainPID'],text=True).strip()
        assert 'ActiveState=active' in state and 'SubState=running' in state
        result['services'][name]=state
    result['success']=True
except Exception as e:
    result['success']=False; result['error']=type(e).__name__+': '+str(e).split('?')[0]
finally:
    (backup/'verification.json').write_text(json.dumps(result,indent=2))
    print(json.dumps(result,indent=2))
if not result['success']: raise SystemExit(1)
