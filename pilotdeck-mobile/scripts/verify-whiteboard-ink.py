#!/usr/bin/env python3
"""Prove the blank-page whiteboard flow against a throwaway sidecar.

Runs the real artifacts_console.py with a copied data dir on a free port so the
production artifacts.db is never touched, then walks the exact sequence the
browser performs: create a file-less whiteboard for a session, attach a stroke
annotation to it, and read it back with anchor.strokes intact.
"""
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

# <repo>/pilotdeck-mobile/scripts/verify-whiteboard-ink.py -> <repo>
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SESSION = "web:s_8e1f6b79-7a66-4e90-b7dd-caf46c7118f2"  # a real session id: workspace only lists sessions it finds


def free_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def request(method, url, payload=None, token=None):
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    if data is not None:
        req.add_header("Content-Type", "application/json")
    if token:
        req.add_header("X-Console-Token", token)
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            return resp.status, json.loads(resp.read().decode() or "{}")
    except urllib.error.HTTPError as exc:
        return exc.code, json.loads(exc.read().decode() or "{}")


def main():
    workdir = tempfile.mkdtemp(prefix="artifacts-whiteboard-verify-")
    data_dir = os.path.join(workdir, ".artifacts-data")
    source = os.path.join(ROOT, ".artifacts-data")
    if os.path.isdir(source):
        # chrome-profile* holds live Chromium sockets that cannot be copied; the
        # database and stored files are what this check actually needs.
        shutil.copytree(
            source, data_dir,
            ignore=shutil.ignore_patterns("chrome-profile*", "Singleton*", "*.sock"),
            ignore_dangling_symlinks=True,
        )
    else:
        os.makedirs(data_dir, exist_ok=True)
    # The live data dir is group-locked; a verbatim copy would leave this run
    # unable to create files/ and thumbs/ under it.
    for base, dirs, files in os.walk(data_dir):
        os.chmod(base, 0o700)
        for name in dirs + files:
            try:
                os.chmod(os.path.join(base, name), 0o700)
            except OSError:
                pass
    port = free_port()
    # A copy, never the live env: the real sidecar is authenticated and its
    # secrets must not leak into a verification run.
    env = dict(os.environ)
    env.update({
        "ARTIFACTS_DATA_DIR": data_dir,
        "ARTIFACTS_WATCH_DIRS": "",
        "ARTIFACTS_TOKEN": "",
        "ARTIFACTS_CONSOLE_PASSWORD": "",
    })
    server = subprocess.Popen(
        [sys.executable, os.path.join(ROOT, "service", "serve_artifacts.py"),
         "--host", "127.0.0.1", "--port", str(port)],
        cwd=ROOT, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
    )
    base = f"http://127.0.0.1:{port}"
    failures = []
    try:
        for _ in range(60):
            try:
                if request("GET", base + "/api/artifacts/health")[0] == 200:
                    break
            except Exception:
                pass
            if server.poll() is not None:
                print("server exited:", server.stdout.read()[:2000])
                return 1
            time.sleep(0.5)
        else:
            failures.append("sidecar never became healthy")
            raise SystemExit(1)

        status, data = request("POST", base + "/api/artifacts", {
            "kind": "drawing",
            "title": "手绘草稿 verify",
            "run_id": SESSION,
            "agent": "pilotv-reviewer",
            "deliverable": "aux",
            "status": "ready",
            "meta": {"whiteboard": True},
        })
        print(f"[1] create whiteboard -> HTTP {status} {json.dumps(data)[:220]}")
        if status != 201 and status != 200:
            failures.append(f"whiteboard create returned {status}: {data}")
            raise SystemExit(1)
        artifact_id = data.get("artifact", {}).get("id") or data.get("id")

        strokes = [{
            "color": "#e5484d", "w": 0.005,
            "points": [{"x": 0.2, "y": 0.3, "p": 0.5}, {"x": 0.55, "y": 0.42, "p": 0.8}, {"x": 0.6, "y": 0.8, "p": 0.5}],
        }]
        rect = {"x": 0.2, "y": 0.3, "w": 0.4, "h": 0.5}
        status, note = request("POST", f"{base}/api/artifacts/{artifact_id}/annotations", {
            "body": "这里要改", "severity": "minor", "anchor": {"rect": rect, "strokes": strokes},
        })
        print(f"[2] add stroke annotation -> HTTP {status} {json.dumps(note, ensure_ascii=False)[:260]}")
        if status not in (200, 201):
            failures.append(f"annotation create returned {status}: {note}")

        status, detail = request("GET", f"{base}/api/artifacts/{artifact_id}")
        notes = (detail or {}).get("annotations") or []
        stored = (notes[0].get("anchor") or {}) if notes else {}
        print(f"[3] read back -> HTTP {status} notes={len(notes)} "
              f"rect={json.dumps(stored.get('rect'))} strokes={len(stored.get('strokes') or [])}")
        if not notes:
            failures.append("annotation did not round-trip")
        else:
            if len(stored.get("strokes") or []) != 1:
                failures.append("anchor.strokes was dropped by the store")
            if (stored.get("rect") or {}).get("x") != 0.2:
                failures.append(f"rect not normalized as sent: {stored.get('rect')}")
            if (stored.get("strokes") or [{}])[0].get("points", [{}])[0].get("p") != 0.5:
                failures.append("stroke pressure did not round-trip")

        status, ws = request("GET", base + "/api/artifacts/workspace")
        matched = []
        for project in (ws.get("projects") or []):
            for sess in project.get("sessions") or []:
                if sess.get("id") == SESSION:
                    matched = sess.get("artifacts") or []
        print(f"[4] session attribution -> HTTP {status} artifacts_in_session={len(matched)} "
              f"titles={[a.get('title') for a in matched]}")
        if not matched:
            failures.append("whiteboard was not attributed to its session in /api/artifacts/workspace")

        status, feedback = request("GET", f"{base}/api/artifacts/{artifact_id}/feedback?status=open")
        print(f"[5] feedback -> HTTP {status} count={(feedback or {}).get('count')}")
        if not (feedback or {}).get("count"):
            failures.append("stroke note missing from the feedback endpoint the agent reads")
    finally:
        server.terminate()
        try:
            server.wait(timeout=10)
        except subprocess.TimeoutExpired:
            server.kill()
        shutil.rmtree(workdir, ignore_errors=True)

    if failures:
        print("\nFAILED:")
        for item in failures:
            print(" -", item)
        return 1
    print("\nOK: whiteboard + stroke annotation round-trip verified on an isolated sidecar")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())