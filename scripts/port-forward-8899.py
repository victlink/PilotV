#!/usr/bin/env python3
"""8899 → 8799 的 TCP 转发（兼容垫片）。

为什么需要这个垫片：
    有一处 MCP 侧车配置把 console 地址写成了 http://127.0.0.1:8899
    （8899 是早期联调用的 serve_test.py 端口，文档里还留着，见 RUNBOOK）。
    8899 上什么都没有，表现为：成果台网页能看、MCP 工具一调就 "fetch failed"。

    正路是改配置：把 ARTIFACTS_API 改成 http://127.0.0.1:8799。
    但那份配置在宿主会话里、当前会话改不了，而重拉那个进程有跟宿主抢 8801
    的风险。垫片不碰任何进程，只在空闲的 8899 上做字节转发，
    改完配置、不再需要时 `python3 scripts/port-forward-8899.py stop` 即可。

用法：
    python3 scripts/port-forward-8899.py            # 起（已在跑就直接返回）
    python3 scripts/port-forward-8899.py stop
    python3 scripts/port-forward-8899.py status
"""
from __future__ import annotations

import asyncio
import os
import socket
import sys

LISTEN = ("127.0.0.1", 8899)
TARGET = ("127.0.0.1", 8799)
RUN_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                       ".artifacts-data")
PID_FILE = os.path.join(RUN_DIR, "forward-8899.pid")
LOG_FILE = os.path.join(RUN_DIR, "forward-8899.log")


def port_open(host_port) -> bool:
    s = socket.socket()
    s.settimeout(0.4)
    try:
        return s.connect_ex(host_port) == 0
    finally:
        s.close()


def alive_pid() -> int:
    try:
        pid = int(open(PID_FILE, encoding="utf-8").read().strip())
    except Exception:
        return 0
    if pid and os.path.exists(f"/proc/{pid}"):
        return pid
    return 0


async def pipe(reader, writer):
    try:
        while data := await reader.read(65536):
            writer.write(data)
            await writer.drain()
    except Exception:
        pass
    finally:
        try:
            writer.close()
        except Exception:
            pass


async def handle(client_reader, client_writer):
    try:
        server_reader, server_writer = await asyncio.open_connection(*TARGET)
    except Exception:
        client_writer.close()
        return
    await asyncio.gather(pipe(client_reader, server_writer),
                         pipe(server_reader, client_writer))


async def main():
    server = await asyncio.start_server(handle, *LISTEN)
    print(f"转发中 {LISTEN[0]}:{LISTEN[1]} → {TARGET[0]}:{TARGET[1]}", flush=True)
    async with server:
        await server.serve_forever()


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "start"
    if cmd == "status":
        pid = alive_pid()
        print(f"{'运行中' if pid and port_open(LISTEN) else '未运行'}"
              + (f"（pid {pid}）" if pid else ""))
        sys.exit(0 if pid and port_open(LISTEN) else 1)
    if cmd == "stop":
        pid = alive_pid()
        if pid:
            os.kill(pid, 15)
            print(f"已停（pid {pid}）")
        else:
            print("本来就没在跑")
        if os.path.exists(PID_FILE):
            os.remove(PID_FILE)
        sys.exit(0)
    # start
    if port_open(LISTEN):
        print(f"{LISTEN[0]}:{LISTEN[1]} 已被占用（可能就是它在跑），不重复起")
        sys.exit(0)
    os.makedirs(RUN_DIR, exist_ok=True)
    pid = os.fork()
    if pid > 0:
        with open(PID_FILE, "w", encoding="utf-8") as fh:
            fh.write(str(pid))
        # 等它真的监听上再报成功
        for _ in range(40):
            if port_open(LISTEN):
                print(f"垫片已起（pid {pid}，日志 {LOG_FILE}）")
                sys.exit(0)
            import time
            time.sleep(0.1)
        print("启动超时，日志：")
        sys.exit(1)
    os.setsid()
    log = os.open(LOG_FILE, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
    os.dup2(log, 1)
    os.dup2(log, 2)
    asyncio.run(main())