#!/usr/bin/env bash
# 复现用户报的四个问题的环境：隔离数据目录 + 隔离 PilotDeck 家目录（造假会话树）+ 起服务。
#
# 不复用 .artifacts-data，绝不污染真实成果库。
# 跑法：bash scripts/diag_repro.sh
set -uo pipefail
cd "$(dirname "$0")/.."

export ARTIFACTS_DATA_DIR=${ARTIFACTS_DATA_DIR:-/tmp/art-diag-data}
export PILOTDECK_HOME=${PILOTDECK_HOME:-/tmp/art-diag-home}
rm -rf "$ARTIFACTS_DATA_DIR" "$PILOTDECK_HOME"
mkdir -p "$ARTIFACTS_DATA_DIR"

# ---- 造假 PilotDeck 家目录：两个项目、三个会话（其中一个活跃）----
now=$(python3 -c 'import time;print(time.time())')
mk_session() {  # mk_session <slug> <sid> <title> <age_s>
  local slug=$1 sid=$2 title=$3 age=$4
  local d="$PILOTDECK_HOME/projects/$slug/chats"
  mkdir -p "$d"
  printf '{"type":"session_metadata","title":"%s","aiTitle":"%s"}\n' "$title" "$title" > "$d/cli:$sid.jsonl"
  local t=$(python3 -c "print($now - $age)")
  touch -d "@$t" "$d/cli:$sid.jsonl"
}
for slug in projA projB; do
  mkdir -p "$PILOTDECK_HOME/projects/$slug"
  echo "/tmp/$slug" > "$PILOTDECK_HOME/projects/$slug/.cwd"
done
# projA：老会话（2 小时前）+ 活跃会话（刚更新）
mk_session projA sA-old "A 的老会话" 7200
mk_session projA sA-live "A 的活跃会话" 5
mk_session projB sB-one "B 的会话" 3600

PORT=${PORT:-$(python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1]);s.close()')}
echo "[diag] 端口 $PORT  数据 $ARTIFACTS_DATA_DIR  家目录 $PILOTDECK_HOME"
python3 -u scripts/serve_test.py --port "$PORT" >/tmp/art-diag-serve.log 2>&1 &
SRV=$!
trap 'kill $SRV 2>/dev/null || true; pkill -f "remote-debugging-port=9411" 2>/dev/null || true' EXIT
for i in $(seq 1 60); do
  curl -sf "http://127.0.0.1:$PORT/api/artifacts/health" >/dev/null 2>&1 && break
  sleep 0.3
done

# ---- 种数据：每个会话各挂几个成果，文本类足够多以便观察左栏 ----
python3 - "$PORT" <<'PY'
import json, os, sys, urllib.request, time
port = sys.argv[1]; base = f"http://127.0.0.1:{port}/api/artifacts"
def post(path, body):
    req = urllib.request.Request(base + path, data=json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json"}, method="POST")
    try:
        return json.load(urllib.request.urlopen(req, timeout=15))
    except Exception as e:
        print("[seed] 失败", path, e); return {}

html = "<html><body style='font-family:sans-serif'>" + "".join(
    f"<section style='padding:20px'><h2>第{i}块内容</h2><p>这是成果 {i} 的一段正文，用来占位。</p></section>"
    for i in range(1, 6)) + "</body></html>"

# 归属走 run_id（精确）或 source.path 落在项目工作目录下（兜底），两条都给
plan = [("projA", "cli:sA-live", 6), ("projA", "cli:sA-old", 4), ("projB", "cli:sB-one", 5)]
made = 0
for proj, sess, n in plan:
    workdir = f"/tmp/{proj}"
    os.makedirs(workdir, exist_ok=True)
    for i in range(n):
        fp = os.path.join(workdir, f"art-{sess.replace(':','-')}-{i+1}.html")
        with open(fp, "w", encoding="utf-8") as fh:
            fh.write(html)
        r = post("", {"title": f"{proj} 成果{i+1}", "kind": "page",
                      "run_id": sess, "project": proj, "path": fp, "agent": "pilotdeck"})
        if not r.get("id"):
            print("[seed] 建失败:", proj, sess, i, r); continue
        made += 1
        # 顺手给每条挂一条未解决标注，让「应用/提交」键有真实状态
        post(f"/{r['id']}/annotations",
             {"rect": {"x": .2, "y": .2, "w": .3, "h": .2}, "body": "这里要改一下排版", "severity": "major"})
print(f"[seed] 建出 {made} 个成果")

ws = json.load(urllib.request.urlopen(f"{base}/workspace", timeout=15))
for p in ws.get("projects", []):
    print(f"[seed]   项目 {p['name']}: 直属 {len(p.get('artifacts', []))} | "
          + ", ".join(f"{s['id']}={len(s.get('artifacts', []))}" for s in p.get("sessions", [])))
PY

echo "[diag] 跑浏览器诊断"
node scripts/diag_repro.mjs "http://127.0.0.1:$PORT/artifacts.html"
rc=$?
echo "[diag] 退出码 $rc"
exit $rc
