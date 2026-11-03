"""Verify generated carriage and attached birth stations in real Chromium."""
from pathlib import Path
import subprocess, re, json
root=Path(__file__).resolve().parents[2]
svg=(root/'brand/pilotv-logo-animated-dark.svg').read_text()
page=root/'design/logo/animated-frames/qa-carriage.html'
page.write_text('<html><body>'+svg+'''<pre id="result"></pre><script>
window.onload=()=>{
const svg=document.querySelector('svg'), animations=svg.getAnimations({subtree:true});
function pose(t){animations.forEach(a=>{a.pause();a.currentTime=t*8400});
return [...svg.querySelectorAll('.carriage')].map(e=>new DOMMatrix(getComputedStyle(e).transform).m41)}
let poses=[0,.19,.295,.4,.505,.73,.805,.88,.955,1].map(t=>({t,x:pose(t)}));
let births=[['i',.07],['l',.175],['o',.28],['t',.385],['t',.73],['o',.805],['l',.88],['i',.955]].map(([ch,t])=>{
const cx=pose(t)[0],g=svg.querySelector('.fly-'+ch),m=new DOMMatrix(getComputedStyle(g).transform);
return {ch,error:Math.abs(Number(g.dataset.foot)+m.m41-Number(g.dataset.station)-cx)};
});
const passed=poses.every(p=>Math.abs(p.x[0]-p.x[1])<.01)&&poses[0].x[0]===-125&&Math.abs(poses[4].x[0])<.01&&poses[9].x[0]===-125&&births.every(b=>b.error<.1);
document.querySelector('#result').textContent=JSON.stringify({passed,poses,births});
};</script></body></html>''')
r=subprocess.run(['/snap/bin/chromium','--headless','--no-sandbox','--disable-gpu','--dump-dom','--virtual-time-budget=2000',page.as_uri()],capture_output=True,text=True,check=True)
m=re.search(r'<pre id="result">(.*?)</pre>',r.stdout)
assert m, r.stdout[-2000:]
data=json.loads(m.group(1));print(json.dumps(data,indent=2));assert data['passed']
