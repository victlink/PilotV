"""PilotV-Setup.exe 入口：自解压后把内嵌的 PowerShell 安装脚本交给 Windows PowerShell 执行。

单文件 EXE 里只有本脚本 + PilotV-Install.ps1；不写注册表、不需要管理员权限。
"""
import os
import subprocess
import sys

PRODUCT = "PilotV"
VERSION = "0.1.2"


def _powershell() -> str:
    root = os.environ.get("SystemRoot", r"C:\Windows")
    candidate = os.path.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
    return candidate if os.path.isfile(candidate) else "powershell.exe"


def main() -> int:
    args = sys.argv[1:]
    if args and args[0] in ("--version", "-Version", "-v"):
        print(f"{PRODUCT} Windows Setup {VERSION}")
        return 0
    base = getattr(sys, "_MEIPASS", os.path.dirname(os.path.abspath(__file__)))
    script = os.path.join(base, "PilotV-Install.ps1")
    if not os.path.isfile(script):
        print("安装包损坏：找不到内嵌的 PilotV-Install.ps1", file=sys.stderr)
        return 2
    cmd = [
        _powershell(),
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-NoLogo",
        "-File",
        script,
    ] + args
    return subprocess.call(cmd)


if __name__ == "__main__":
    sys.exit(main())
