import assert from "node:assert/strict";
import { test } from "node:test";
import http from "node:http";
import type { Gateway } from "../protocol/types.js";
import { buildGatewayHealthPayload, getSessionHealthTracker, resetSessionHealthTracker } from "./gatewayHealth.js";
import { startGatewayServer } from "../server/GatewayServer.js";

// 这份测试守的是「健康检查能不能定位问题」。HANDOFF 那次排障最难的地方是
// 端口能连、进程在，但每个会话都在失败 —— 而当时没有任何接口能区分这两件事。

type Event = Parameters<ReturnType<typeof getSessionHealthTracker>["observe"]>[0];
const compactFailed = (): Event => ({
  type: "agent_status",
  event: "compact_completed",
  detail: { status: "failed", trigger: "auto", preTokens: 86000 },
}) as Event;
const compactOk = (): Event => ({
  type: "agent_status",
  event: "compact_completed",
  detail: { status: "success", trigger: "auto", preTokens: 20000 },
}) as Event;

test("没有会话时：healthy，压缩成功率是 null 而不是 1", () => {
  resetSessionHealthTracker();
  const payload = buildGatewayHealthPayload({ wsConnections: 0 });
  assert.equal(payload.ok, true);
  assert.equal(payload.status, "healthy");
  assert.equal(payload.healthScope, "none");
  assert.equal(payload.compaction.successRate, null);
  assert.equal(payload.wsConnections, 0);
  assert.equal(typeof payload.pid, "number");
  assert.equal(Number.isFinite(Date.parse(payload.at)), true);
});

test("只有一条会话坏：degraded-partial，ok 仍为 true（不该为此重启整个网关）", () => {
  resetSessionHealthTracker();
  const tracker = getSessionHealthTracker();
  tracker.observe(compactFailed(), { sessionKey: "sick" });
  tracker.observe(compactFailed(), { sessionKey: "sick" });
  tracker.observe(compactOk(), { sessionKey: "fine" });

  const payload = buildGatewayHealthPayload({ wsConnections: 3 });
  assert.equal(payload.status, "degraded-partial");
  assert.equal(payload.ok, true, "局部故障不值得重启进程：重启也治不好，还会把好的会话一起踢掉");
  assert.equal(payload.degradedSessions, 1);
  assert.equal(payload.sessions, 2);
  assert.equal(payload.reasons.length, 1);
  assert.match(payload.reasons[0]?.reason ?? "", /上下文压缩失败/);
});

test("所有会话都在失败：ok=false，这时重启才有意义", () => {
  resetSessionHealthTracker();
  const tracker = getSessionHealthTracker();
  for (const key of ["a", "b"]) {
    tracker.observe(compactFailed(), { sessionKey: key });
    tracker.observe(compactFailed(), { sessionKey: key });
  }
  const payload = buildGatewayHealthPayload({ wsConnections: 2 });
  assert.equal(payload.healthScope, "all");
  assert.equal(payload.status, "degraded");
  assert.equal(payload.ok, false);
  assert.equal(payload.compaction.failed, 4);
  assert.equal(payload.compaction.successRate, 0);
});

test("reasons 最多带 5 条，健康检查不该把自己变成日志洪水", () => {
  resetSessionHealthTracker();
  const tracker = getSessionHealthTracker();
  for (let i = 0; i < 9; i += 1) {
    const key = `s${i}`;
    tracker.observe(compactFailed(), { sessionKey: key });
    tracker.observe(compactFailed(), { sessionKey: key });
  }
  const payload = buildGatewayHealthPayload({ wsConnections: 0 });
  assert.equal(payload.degradedSessions, 9);
  assert.equal(payload.reasons.length, 5);
});

test("/healthz 真的挂上了：200 + 结构化字段，且不影响原有 /health", async () => {
  resetSessionHealthTracker();
  const server = await startGatewayServer({
    gateway: {} as Gateway,
    port: 0,
    token: "test-token",
    serverVersion: "test",
  });
  try {
    const healthz = await getJson(`${server.url}/healthz`);
    assert.equal(healthz.status, 200);
    assert.equal(healthz.body.status, "healthy");
    assert.equal(healthz.body.serverVersion, "test");
    // 缓存必须关掉：supervisor 每 3 秒探一次，命中缓存就等于永远看不见状态变化。
    assert.equal(healthz.headers["cache-control"], "no-store");

    const health = await getJson(`${server.url}/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(health.body, { ok: true }, "/health 的老语义不能被改坏，别处还在用");
  } finally {
    await server.close();
    resetSessionHealthTracker();
  }
});

function getJson(url: string): Promise<{ status: number; body: Record<string, unknown>; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const request = http.get(url, response => {
      let text = "";
      response.setEncoding("utf8");
      response.on("data", chunk => { text += chunk; });
      response.on("end", () => {
        let body: Record<string, unknown> = {};
        try { body = JSON.parse(text) as Record<string, unknown>; } catch { /* 保留原文为空对象 */ }
        resolve({ status: response.statusCode ?? 0, body, headers: response.headers });
      });
    });
    request.on("error", reject);
  });
}