// doctor 的判定逻辑。全部是纯函数：给定事实，给出结论 + 一句人话。
//
// 为什么要和采集分开：verify_windows.ps1 早就存在，也早就覆盖了端口/补丁/清单，
// 但它把「怎么取事实」和「什么算坏」揉在 PowerShell 里，结果既没法测、也没人跑
// （本仓库第四次出现「检查早就有、缺的是执行者」）。判定抽出来之后，每一条都能
// 单独喂一个事实进去断言，CI 里跑得动，命令行也只是它的一个出口。

/** @typedef {"pass"|"warn"|"fail"} Severity */
/** @typedef {{ id: string, title: string, severity: Severity, detail: string, fix?: string }} Finding */

/** 端口探测失败原因 -> 人话。区分「没人听」和「有人但不说人话」是这条命令的价值所在。 */
export function describeProbeError(error, target) {
  const code = error?.code || "";
  const map = {
    ECONNREFUSED: {
      severity: "fail",
      detail: `${target} 没人监听（连接被拒）。服务没起来，或者端口填错了。`,
      fix: "看 .run/*.log 最近 50 行；确认启动器跑过",
    },
    ETIMEDOUT: {
      severity: "fail",
      detail: `${target} 连接超时。TCP  SYN 没回，通常是防火墙丢包或设备不在线。`,
      fix: "先 tailscale status 看设备在不在网里",
    },
    ECONNRESET: {
      severity: "fail",
      detail: `${target} 有人应了但立刻断开：端口上是别的服务，或者协议用反了（http 敲 https）。`,
    },
    EPROTO: {
      severity: "fail",
      detail: `${target} 协议不匹配：用明文去敲了 TLS 端口（或反之）。`,
      fix: "对照 devices.json 里的 scheme；网关 5186 是 HTTPS，后端 3001 是 HTTP",
    },
    ERR_TLS_CERT_ALTNAME_INVALID: {
      severity: "warn",
      detail: `${target} 证书的有效域名和访问地址不一致（自签证书按 IP 签、却用域名访问，或反之）。`,
      fix: "重签证书时把 MagicDNS 域名和 IP 都放进 SAN",
    },
    CERT_EXPIRED: { severity: "fail", detail: `${target} 证书已过期。`, fix: "跑证书续期" },
    UND_ERR_SOCKET: { severity: "fail", detail: `${target} 套接字被对端关闭。` },
  };
  const hit = map[code];
  if (hit) return { ...hit, code };
  const cause = error?.errors?.[0]?.code;
  if (cause && map[cause]) return { ...map[cause], code: cause };
  return { severity: "fail", detail: `${target} 探测失败：${code || error?.message || "未知错误"}`, code: code || "unknown" };
}

/**
 * 「监听中的端口」-> 每个端口的结论。
 *
 * 端口占用者一律反查（谁在听），不读 pids.json —— 那份文件记录的是「我以为我起了
 * 什么」，端口才是唯一的事实来源。
 */
export function evaluatePorts(expected, listeners) {
  const owners = new Map();
  for (const entry of listeners) {
    if (!owners.has(entry.port)) owners.set(entry.port, []);
    owners.get(entry.port).push(entry);
  }
  return expected.map(({ port, name, required = true }) => {
    const holders = owners.get(port) || [];
    if (holders.length === 0) {
      return {
        id: `port:${port}`,
        title: `${name} 端口 ${port}`,
        severity: required ? "fail" : "warn",
        detail: "没有监听者",
        fix: required ? "启动这个服务，或确认端口号" : "这个服务是可选的",
      };
    }
    if (holders.length > 1) {
      // 两个进程抢同一个端口的表现是「时好时坏」，比直接连不上更难查。
      return {
        id: `port:${port}`,
        title: `${name} 端口 ${port}`,
        severity: "fail",
        detail: `${holders.length} 个进程同时在听（pid ${holders.map(h => h.pid).join(", ")}）`,
        fix: "只留一个；另一个多半是没停干净的旧实例",
      };
    }
    return {
      id: `port:${port}`,
      title: `${name} 端口 ${port}`,
      severity: "pass",
      detail: `pid ${holders[0].pid}${holders[0].command ? ` (${holders[0].command})` : ""}`,
    };
  });
}

/** 清单同步结论：把「两份 devices.json 不一致」这件事说成人话。 */
export function evaluateManifestSync(result) {
  if (result.synced) {
    return { id: "devices:sync", title: "设备清单已同步到 dist", severity: "pass", detail: `${result.from} -> ${result.to}` };
  }
  switch (result.reason) {
    case "already-in-sync":
      return { id: "devices:sync", title: "设备清单已同步到 dist", severity: "pass", detail: "内容一致，无需写盘" };
    case "dist-missing":
      return {
        id: "devices:sync", title: "设备清单同步", severity: "fail",
        detail: "还没构建出 dist/devices.json",
        fix: "先构建前端；网关不该替 vite 造一个 dist",
      };
    case "source-invalid":
      return {
        id: "devices:sync", title: "设备清单内容有问题", severity: "warn",
        detail: (result.problems || []).join("; ") || "未说明",
        fix: "改完 ui/public/devices.json 再重启网关（loadConfigFromEnv 只在启动时读）",
      };
    case "out-of-sync":
      // 注意这是「还没同步」而不是「同步失败」：网关每次启动都会同步一次，所以
      // 两份不一致的真实含义是「改完 public 之后还没重启网关」。
      return {
        id: "devices:sync", title: "设备清单两份不一致", severity: "fail",
        detail: "浏览器读到的还是上一版清单",
        fix: "重启 5186（loadConfigFromEnv 在启动时同步一次），或跑 pilotv doctor --fix-manifest",
      };
    case "dist-missing-source-ok":
      return { id: "devices:sync", title: "设备清单同步", severity: "fail", detail: "还没构建出 dist/devices.json", fix: "先构建前端" };
    default:
      return { id: "devices:sync", title: "设备清单同步", severity: "warn", detail: String(result.reason || "未同步").slice(0, 160) };
  }
}

/** 日志体积：5 MB 以上说明又在写循环里打转（1.82 GB 那次的教训）。 */
export function evaluateLogSize(name, sizeInBytes, limitBytes = 5 * 1024 * 1024) {
  const mb = (sizeInBytes / 1024 / 1024).toFixed(1);
  if (sizeInBytes > limitBytes) {
    return { id: `log:${name}`, title: `日志体积 ${name}`, severity: "fail", detail: `${mb} MB`, fix: "确认轮转在跑；再查是不是死循环刷屏" };
  }
  return { id: `log:${name}`, title: `日志体积 ${name}`, severity: "pass", detail: `${mb} MB` };
}

/**
 * 证书有效期结论。<14 天先 warn，是给人留出续期时间，不是等过期再救火。
 *
 * daysSinceValidFrom 是「距签发已过去几天」：负数才代表还没生效
 * （签发时间在未来，多半是系统时钟不对）。第一版把正负读反，把好证书报成
 * 「还没生效」—— 参数名因此改成不会读错的写法。
 */
export function evaluateCertExpiry(daysRemaining, daysSinceValidFrom = null) {
  if (daysRemaining === null || daysRemaining === undefined) {
    return { id: "tls:expiry", title: "网关证书", severity: "warn", detail: "读不到有效期", fix: "证书不是 X.509，或读它的方式变了" };
  }
  if (Number.isFinite(daysSinceValidFrom) && daysSinceValidFrom < 0) {
    return { id: "tls:expiry", title: "网关证书", severity: "fail", detail: `还没生效（签发时间在未来 ${-daysSinceValidFrom} 天，系统时钟大概率不对）`, fix: "校时；时钟不准时 TLS 全部失败" };
  }
  if (daysRemaining < 0) {
    return { id: "tls:expiry", title: "网关证书", severity: "fail", detail: `已过期 ${-daysRemaining} 天`, fix: "续期证书并重启网关" };
  }
  if (daysRemaining < 14) {
    return { id: "tls:expiry", title: "网关证书", severity: "warn", detail: `还剩 ${daysRemaining} 天`, fix: "尽快续期；自动续期的计划任务也要查" };
  }
  return { id: "tls:expiry", title: "网关证书", severity: "pass", detail: `还剩 ${daysRemaining} 天` };
}

/**
 * /healthz 的结论。注意 ok=true + degraded 的组合是**正常**的：
 * 一条会话坏了不值得重启进程，重启也治不好，还会把好的会话一起踢掉。
 */
export function evaluateHealthz(body, httpStatus, { rawText = "" } = {}) {
  if (httpStatus !== 200) {
    return { id: "healthz", title: "网关健康明细", severity: "fail", detail: `HTTP ${httpStatus}`, fix: "/healthz 设计上永不 5xx；非 200 说明进程本身不对" };
  }
  if (!body || typeof body !== "object") {
    // 200 + 一坨 HTML 是前端 SPA 的兜底页：说明这个端口上的进程根本没这个路由，
    // 也就是跑着的构建比仓库旧。说得直白点，否则下一个人还会以为是探错了地址。
    const looksLikeHtml = typeof rawText === "string" && /^\s*<(!doctype|html)/i.test(rawText);
    return {
      id: "healthz", title: "网关健康明细", severity: "fail",
      detail: looksLikeHtml ? "返回的是前端页面而不是 JSON：这个端口上的进程没有 /healthz 路由" : "返回的不是 JSON",
      fix: looksLikeHtml ? "跑着的构建比仓库旧（/healthz 是后加的），重建并重启该服务；确认探的是 agent gateway 18789 而不是前端网关 5186" : "看网关日志",
    };
  }
  const reasons = (body.reasons || []).map(r => `${r.sessionKey}: ${r.reason}`).join(" | ");
  if (body.ok === false) {
    return { id: "healthz", title: "网关健康明细", severity: "fail", detail: `${body.status} — ${reasons || "全部会话在失败"}`, fix: "会话级熔断判定为整体不可用；看 reasons 里第一条的会话" };
  }
  if (body.status !== "healthy") {
    return { id: "healthz", title: "网关健康明细", severity: "warn", detail: `${body.status}（降级 ${body.degradedSessions}/${body.sessions} 条会话）— ${reasons}`, fix: "局部降级：只处理出问题的那条会话，别重启进程" };
  }
  return {
    id: "healthz", title: "网关健康明细", severity: "pass",
    detail: `会话 ${body.sessions ?? 0}，ws ${body.wsConnections ?? 0}，压缩成功率 ${body.compaction?.successRate ?? "n/a"}`,
  };
}

/** 上游那三处补丁有没有被 vendor 更新覆盖回去。 */
export function evaluateUpstreamPatches(patches) {
  const missing = patches.filter(p => !p.present);
  if (missing.length === 0) {
    return { id: "upstream:patches", title: "三处上游补丁在位", severity: "pass", detail: patches.map(p => p.key).join(", ") };
  }
  return {
    id: "upstream:patches", title: "三处上游补丁", severity: "fail",
    detail: `缺 ${missing.map(p => p.key).join(", ")}`,
    fix: "vendor 更新把它们覆盖回去了；重放 patches/ 里的系列（见 P3.4）",
  };
}

/** 把 findings 汇成一个可机读的结果。退出码只看 fail：warn 不该让 CI 红。 */
export function summarize(findings) {
  const counts = { pass: 0, warn: 0, fail: 0 };
  for (const finding of findings) counts[finding.severity] += 1;
  return {
    ok: counts.fail === 0,
    counts,
    exitCode: counts.fail === 0 ? 0 : 1,
    findings,
    // 只列需要人处理的：全 pass 的时候没必要读 40 行「一切正常」。
    actionable: findings.filter(f => f.severity !== "pass"),
  };
}

/** 终端输出。只着色、不夹判断。 */
export function formatText(report, { color = true } = {}) {
  const mark = { pass: "PASS", warn: "WARN", fail: "FAIL" };
  const paint = (text, severity) => {
    if (!color) return text;
    const code = { pass: "32", warn: "33", fail: "31" }[severity];
    return `\u001b[${code}m${text}\u001b[0m`;
  };
  const lines = report.findings.map(finding =>
    `${paint(mark[finding.severity].padEnd(4), finding.severity)} ${finding.title}  ${finding.detail}` +
    (finding.severity !== "pass" && finding.fix ? `\n       怎么办：${finding.fix}` : ""));
  lines.push("");
  lines.push(report.ok
    ? paint(`全部通过（${report.counts.pass} 项${report.counts.warn ? `，另有 ${report.counts.warn} 项提醒` : ""}）`, "pass")
    : paint(`${report.counts.fail} 项失败${report.counts.warn ? `，${report.counts.warn} 项提醒` : ""}`, "fail"));
  return lines.join("\n");
}
