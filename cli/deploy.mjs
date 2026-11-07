// pilotv deploy <device> —— 把散在 8 个 deploy_* 脚本里的部署动作收敛成一个幂等计划。
//
// 为什么是「计划 + 一个执行器」而不是重写一遍：
// scripts/deploy_pilotv_device.sh 已经是 286 行、在 NAS 和 Mac 上真跑通过的 bash，
// 里面每一条「为什么要这么绕」都有注释（launchd 的 PATH、非交互 ssh 的 PATH、
// 没 lockfile 时不能 npm ci、data/ 绝不覆盖）。在 Windows 上、且本机根本没有 bash
// 的情况下把它翻成 JS，等于用没验证过的实现替换验证过的实现 —— 那不是收敛，是重开
// 一个坑。所以这里收敛的是**决策**（这台设备现在缺什么、因此该跑哪几步），执行仍然
// 下发给那份 bash。
//
// 幂等来自一个原则：先看事实，再决定做不做。端口按谁在监听反查，不读 pids.json
// （它记录的是「我以为我起了什么」）；已经满足的步骤标 skip，重跑第二遍不该有副作用。

import path from 'node:path';

export const REQUIRED_COMMANDS = ['git', 'node', 'npm', 'python3'];
export const GATEWAY_PORT = 5186;
export const ARTIFACTS_PORT = 8799;
export const SCRIPT_PATH = path.posix.join('scripts', 'deploy_pilotv_device.sh');

/**
 * 目标设备当前的事实 -> 该做哪些步骤。纯函数：不 ssh、不读盘，喂什么结论就是什么。
 *
 * 每步形如 { key, title, action: "run" | "skip", why }，顺序即执行顺序。
 */
export function planDeployment({ device, facts, devDir = '~/PilotV' }) {
  if (!device || !device.name) {
    throw new Error('planDeployment 需要 device.name');
  }
  const host = device.host || device.name;
  const gatewayPort = Number(device.gatewayPort) || GATEWAY_PORT;
  const artifactsPort = Number(device.artifactsPort) || ARTIFACTS_PORT;
  const steps = [];
  const add = (key, title, ok, why, extra = {}) => {
    const known = ok !== null && ok !== undefined;
    steps.push({
      key,
      title,
      // 未知按「要执行」处理：部署脚本是幂等的，多跑一次无害；
      // 但把离线设备的未知说成「不满足」是撒谎，所以文案要分开。
      action: ok ? 'skip' : 'run',
      why: ok ? why.done : known ? why.todo : `未确认（登不上或没探到）：${why.todo}`,
      known,
      ...extra,
    });
  };

  add('preflight', '远端依赖体检（git / node / npm / python3）', facts.commandsOk, {
    done: `已在位：${(facts.commands || []).join(', ')}`,
    todo: REQUIRED_COMMANDS.join(' / ') + ' 至少缺一样 —— 先装齐，否则后面每一步都会以看不懂的方式失败',
  });

  add('repo', `开发目录 ${devDir} 就位`, facts.repoReady, {
    done: `已有 git 仓库且 remote 指向本仓库（${facts.repoRemote || 'remote 未记录'}）`,
    todo: facts.repoExists ? '目录在但不是本仓库的 clone：不动它，先人工确认，装错地方比装不上更贵' : `clone 到 ${devDir}`,
  });

  add('deps', '安装依赖', facts.depsReady, {
    done: 'node_modules 与 lockfile 状态已满足',
    todo: '有 lockfile 用 npm ci（可复现），没有退回 npm install —— 上游 .gitignore 排除了 lockfile，硬用 ci 会以 EUSAGE 失败',
  });

  add('build', '构建前端 dist', facts.uiDistReady, {
    done: `dist 已存在（${facts.uiDistMtime ? `更新于 ${facts.uiDistMtime}` : '时间未知'}）`,
    todo: '构建 ui/dist；网关托管的是构建产物而不是源码，不构建就只能看到上一版界面',
  });

  add('cert', 'TLS 证书就位', facts.certReady, {
    done: '已有证书与私钥，网关按 HTTPS 配置',
    todo: '签自签证书（SAN 要同时含 IP 与 MagicDNS 域名）；安卓 Chrome 装桌面应用要求安全上下文，没证书就是装不上',
  });

  add('service', `服务定义与自启（网关 :${gatewayPort}）`, facts.serviceReady, {
    done: `服务定义已存在：${facts.serviceName || '已注册'}`,
    todo: '写 systemd/launchd 定义并启用；node 的绝对路径必须写进去，服务环境的 PATH 和交互式 shell 不是一套',
  });

  add('sidecar', `成果台 :${artifactsPort}`, facts.sidecarReady, {
    done: `成果台已在 :${artifactsPort} 应答 /api/artifacts/health`,
    todo: `部署成果台并起在 :${artifactsPort}；data/ 是评审人的真实成果，只在建目录时创建，绝不覆盖`,
  });

  add('selfcheck', '本机自检（起没起来按端口反查）', facts.selfCheckOk, {
    done: `:${gatewayPort} 与 :${artifactsPort} 都有监听且应答正常`,
    todo: `探 ${host}:${gatewayPort}/${artifactsPort}；启用了 HTTPS 就用 https 探，否则 TLS 失败会看起来像「网关没起来」`,
  });

  const pending = steps.filter((s) => s.action === 'run');
  const unknown = pending.filter((s) => s.known === false).map((s) => s.key);
  return {
    device: device.name,
    host,
    devDir,
    ports: { gateway: gatewayPort, artifacts: artifactsPort },
    steps,
    pending: pending.map((s) => s.key),
    unknown,
    // 全 skip 就是「已经是目标状态了」—— 幂等的定义，不是错误。
    idempotent: true,
    noop: pending.length === 0,
  };
}

/** 清单里查设备：未知设备必须显式报错，绝不静默挑一台或退回本机。 */
export function resolveDevice(devices, requested) {
  const list = Array.isArray(devices) ? devices : [];
  const name = String(requested || '').trim();
  if (!name) {
    return { error: `要指定设备名。已知：${list.map((d) => d.name).join(', ') || '（清单为空）'}` };
  }
  const hits = list.filter((d) => d.name === name);
  if (hits.length === 1) return { device: hits[0] };
  if (hits.length > 1) {
    return { error: `设备清单里 "${name}" 出现 ${hits.length} 次，先修清单再部署` };
  }
  const near = list.filter((d) => String(d.name).startsWith(name[0]) || String(d.name).includes(name));
  return {
    error: `清单里没有设备 "${name}"。已知：${list.map((d) => d.name).join(', ') || '（清单为空）'}`
      + (near.length && near[0].name !== name ? `；你是想部署 ${near[0].name} 吗？` : ''),
  };
}

/** 从 origin 里拿主机名与网关端口 —— 端口以清单为准，不猜、不沿用别台的。 */
export function deviceFromManifest(entry) {
  let url = null;
  try {
    url = new URL(entry.origin);
  } catch {
    return null;
  }
  return {
    name: entry.name,
    host: url.hostname,
    scheme: url.protocol.replace(':', ''),
    gatewayPort: Number(url.port) || (url.protocol === 'https:' ? 443 : 80),
    artifactsPort: Number(entry.artifactsPort) || ARTIFACTS_PORT,
  };
}

/**
 * 下发给远端的执行脚本。
 *
 * 真正的安装动作交给仓库里那份 bash：它是唯一在各台设备上真跑通过的实现。
 * 这里只负责把它「叫到位」，并补两件事：
 *   - PATH：非交互 ssh 的环境里没有 /opt/homebrew/bin 与 ~/.local/bin，
 *     不补就会把已经装好的 node/npm 判成「缺依赖」（原脚本注释里记着这个坑）；
 *   - 目录：仓库在就 git pull --ff-only（拒绝 rebase/merge，宁可停下来问人），
 *     不在才 clone。部署目录下的 data/ 由脚本自己保证「只建不覆盖」。
 * 路径一律走远端变量并加引号：devDir 带空格时裸插值会把一条命令拆成三条。
 */
export function buildRemoteCommand({ repoUrl, devDir = '~/PilotV', device }) {
  if (!repoUrl) throw new Error('buildRemoteCommand 需要 repoUrl');
  if (!device) throw new Error('buildRemoteCommand 需要 device');
  const lines = [
    'set -euo pipefail',
    'export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$HOME/bin:$PATH"',
    `DEV_DIR=${shellQuote(devDir)}`,
    'if [ -d "$DEV_DIR/.git" ]; then cd "$DEV_DIR" && git pull --ff-only; else git clone '
      + shellQuote(repoUrl) + ' "$DEV_DIR"; fi',
    `cd "$DEV_DIR" && PILOTV_PORT=${device.gatewayPort} PILOTV_ARTIFACTS_PORT=${device.artifactsPort}`
      + ` bash ${SCRIPT_PATH} "$(hostname)" "$DEV_DIR"`,
  ];
  return { remote: lines.join('\n') };
}

/** 单引号包住，内部单引号按 shell 惯例先退出再原样拼回。 */
export function shellQuote(value) {
  return "'" + String(value).split("'").join("'\\''") + "'";
}

export function formatPlan(plan, { color = false } = {}) {
  const mark = (action) => (action === 'skip' ? '· 已满足' : '→ 要执行');
  const lines = [
    `目标设备：${plan.device}（${plan.host}）`,
    `端口：网关 ${plan.ports.gateway}　成果台 ${plan.ports.artifacts}　开发目录 ${plan.devDir}`,
    '',
    ...plan.steps.map((s) => `${mark(s.action)} ${s.title}\n    ${s.why}`),
    '',
    plan.noop
      ? '这台设备已经是目标状态，重跑不会有副作用（这就是幂等）。'
      : `待执行 ${plan.pending.length} 步：${plan.pending.join(', ')}`
        + ((plan.unknown || []).length ? '\n    其中未确认（探测没拿到事实）：' + plan.unknown.join(', ') : ''),
  ];
  return lines.join('\n');
}

/**
 * 成果台探测结论：状态码 -> 这台设备的「部署 + 应答」这一步要不要做。
 *
 * 三态里最容易被抹平的是 401：服务在跑、只是不让匿名看。把它和「端口没人听」
 * 一起判成「未部署」，后果是 deploy 每次都坚持重跑那一步 —— 幂等计划立刻变得
 * 不幂等，而这是这个命令唯一承诺的东西。
 * null 表示没探到（连不上/超时），照「要做」处理但文案标未确认。
 */
export function judgeArtifactsProbe({ status = 0, bodyOk = false } = {}) {
  if (!status) return { ready: null, note: '' };
  if (status === 200 && bodyOk) return { ready: true, note: '' };
  if (status === 401 || status === 403) {
    return { ready: true, note: `成果台要求登录（HTTP ${status}）：服务在跑，本次探测读不到健康明细` };
  }
  return { ready: false, note: `成果台端口通但 /api/artifacts/health 不正常（HTTP ${status}）` };
}

/**
 * 自检结论：网关端口通 且 成果台健康，两个都要。
 *
 * 只起一半是最常见的假正常 —— 界面能打开但成果台是空的，看起来像数据丢了。
 * 任一为 null（没探到）时整体也是 null：不知道不等于好，也不等于坏。
 */
export function judgeSelfCheck({ gatewayListening, sidecarReady } = {}) {
  const values = [gatewayListening, sidecarReady];
  // 有一个明确没起来就是不满足；都没否定但有没探到的 -> 不知道；全真才算起来。
  if (values.includes(false)) return false;
  if (values.some((v) => v === null || v === undefined)) return null;
  return true;
}
