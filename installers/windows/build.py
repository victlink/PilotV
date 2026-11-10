"""把 PilotV-Install.ps1 打包成单一 EXE（PyInstaller onefile）。

用法：python build.py
输出：../dist/PilotV-Setup-0.1.2.exe
"""
from __future__ import annotations

import os
import shutil
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
DIST = ROOT / "dist"
VERSION = "0.1.2"
EXE_NAME = f"PilotV-Setup-{VERSION}"
PS1 = HERE / "PilotV-Install.ps1"
LAUNCHER = HERE / "launcher.py"
WORK = HERE / "_build"


def ensure_bom() -> None:
    raw = PS1.read_bytes()
    if raw.startswith(b"\xef\xbb\xbf"):
        return
    PS1.write_bytes(b"\xef\xbb\xbf" + raw)
    print("已给 PowerShell 脚本加 UTF-8 BOM（PowerShell 5.1 读中文所需）")


def main() -> int:
    ensure_bom()
    DIST.mkdir(parents=True, exist_ok=True)
    if WORK.exists():
        shutil.rmtree(WORK)
    WORK.mkdir(parents=True)

    import PyInstaller.__main__  # noqa: WPS433

    PyInstaller.__main__.run(
        [
            "--onefile",
            "--console",
            "--clean",
            "--noconfirm",
            f"--name={EXE_NAME}",
            f"--distpath={WORK / 'out'}",
            f"--workpath={WORK / 'work'}",
            f"--specpath={WORK}",
            f"--add-data={PS1}{os.pathsep}.",
            str(LAUNCHER),
        ]
    )
    built = WORK / "out" / f"{EXE_NAME}.exe"
    if not built.is_file():
        print("构建失败：未找到输出 EXE", file=sys.stderr)
        return 1
    target = DIST / built.name
    shutil.copy2(built, target)
    print(f"输出：{target} ({target.stat().st_size} bytes)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
