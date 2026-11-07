#!/usr/bin/env python3
"""推送前扫一遍将要进仓库的文件，确认里面没有密钥。

只扫「实际会被提交」的文件：git 追踪的，加上未跟踪但没被 .gitignore 排除的。
已忽略的（.artifacts-data/、.artifacts-secrets.env、node_modules/、dist/ 等）
本来就不该进仓库，这里只提示一下它们确实是忽略状态。
"""
import os
import re
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

SKIP_DIRS = {"node_modules", ".git", "dist", "build", "target", ".venv", "__pycache__",
             ".artifacts-data", ".artifacts-secrets", ".pytest_cache", ".mypy_cache"}
SKIP_EXT = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".pdf", ".zip", ".gz", ".tar",
            ".mp3", ".mp4", ".mov", ".woff", ".woff2", ".ttf", ".eot", ".so", ".dylib", ".dll",
            ".exe", ".bin", ".wasm", ".pyc", ".mo", ".db", ".sqlite", ".sqlite3", ".pyd"}

# (说明, 正则) —— 只报「看起来是真凭据」的，避免把示例/占位符当泄露
RULES = [
    ("GitHub token", re.compile(r"gh[pousr]_[A-Za-z0-9]{30,}")),
    ("GitHub PAT (classic)", re.compile(r"\bghp_[A-Za-z0-9]{36}\b")),
    ("Slack token", re.compile(r"xox[abprs]-[A-Za-z0-9-]{10,}")),
    ("OpenAI key", re.compile(r"\bsk-[A-Za-z0-9_-]{32,}\b")),
    ("Anthropic key", re.compile(r"\bsk-ant-[A-Za-z0-9_-]{32,}\b")),
    ("AWS access key id", re.compile(r"\bAKIA[0-9A-Z]{16}\b")),
    ("Google API key", re.compile(r"\bAIza[0-9A-Za-z_-]{35}\b")),
    ("private key block", re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----")),
    ("Tailscale-ish key", re.compile(r"\btskey-[A-Za-z0-9-]{20,}")),
    ("generic bearer secret", re.compile(r'(?i)(secret|passwd|password|token|api_?key)\s*[:=]\s*["\'][^"\'\s]{16,}["\']')),
    ("console session secret", re.compile(r"(?i)(ARTIFACTS_(TOKEN|SECRET|SESSION)[A-Z_]*)\s*=\s*\S{12,}")),
    # 裸长十六进制：sha256/hmac 输出、随机密钥。单独成行、周围没有普通文字时，
    # 基本都是密钥。带缩进/等号的业务哈希不误伤。
    ("bare hex blob", re.compile(r"^[A-Fa-f0-9]{40,128}$")),
]

# 文件名本身就说明它装的是凭据 —— 这类文件**绝不能**出现在公开仓库里。
# 不靠内容猜（按内容猜会把路径、变量名、函数名全误报一遍），直接看文件名。
CREDENTIAL_FILENAMES = re.compile(
    r"(?i)(\.secret$|\.pem$|\.key$|\.p12$|\.pfx$|^credentials|"
    r"^id_(rsa|dsa|ecdsa|ed25519)$|\.token$|\.netrc$|\.env$)")
CREDENTIAL_CONTENT = re.compile(r"^[A-Za-z0-9+/=]{24,}$")


def run(*args):
    return subprocess.run(args, cwd=ROOT, capture_output=True, text=True, timeout=180).stdout


def main():
    tracked = [line for line in run("git", "ls-files").splitlines() if line]
    untracked = run("git", "ls-files", "--others", "--exclude-standard").splitlines()
    # 未跟踪的也要扫：它们会被 git add -A 一起带进去
    candidates = tracked + [p for p in untracked if p]

    print(f"将要进仓库的文件：{len(tracked)} 个已追踪 + {len(untracked)} 个未跟踪")

    findings = []
    scanned = 0
    for rel in candidates:
        full = os.path.join(ROOT, rel)
        ext = os.path.splitext(rel)[1].lower()
        if ext in SKIP_EXT:
            continue
        if any(part in SKIP_DIRS for part in rel.split(os.sep)):
            continue
        try:
            if os.path.getsize(full) > 4 * 1024 * 1024:
                continue
            with open(full, encoding="utf-8") as fh:
                text = fh.read()
        except (OSError, UnicodeDecodeError):
            continue
        scanned += 1
        base = os.path.basename(rel)
        # 文件名像是凭据的，先按文件名记一条，再看内容有没有实际密钥
        if CREDENTIAL_FILENAMES.search(base):
            blob = text.strip()
            if CREDENTIAL_CONTENT.match(blob):
                findings.append((rel, 1, "凭据文件", f"文件名疑似凭据，内容是密钥形态（{len(blob)} 字符）"))
            else:
                findings.append((rel, 1, "凭据文件名", "文件名疑似凭据，确认是否该入库"))
        for num, line in enumerate(text.splitlines(), 1):
            for label, pattern in RULES:
                if pattern.search(line):
                    # 明显的占位符不算
                    low = line.lower()
                    if any(w in low for w in ("example", "your-", "changeme", "placeholder",
                                              "xxxxx", "dummy", "fake", "sample", "<", "...")):
                        continue
                    findings.append((rel, num, label, line.strip()[:160]))

    print(f"实际扫描：{scanned} 个文本文件\n")

    if findings:
        print(f"⚠ 疑似凭据 {len(findings)} 处：")
        for rel, num, label, line in findings:
            print(f"  {rel}:{num}  [{label}]  {line}")
        print("\n推送前必须逐条确认：是真的泄露，还是正则误报。")
        return 1

    print("✓ 没扫到凭据形态的字符串")

    ignored = run("git", "check-ignore", "-v",
                  ".artifacts-secrets.env", ".artifacts-data", "node_modules").strip()
    print("\n敏感路径的忽略状态：")
    if ignored:
        for line in ignored.splitlines():
            print(f"  {line}")
    else:
        print("  ⚠ 上面这些路径没有被忽略！")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
