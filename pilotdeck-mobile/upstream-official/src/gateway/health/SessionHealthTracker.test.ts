import assert from "node:assert/strict";
import { test } from "node:test";
import type { GatewayEvent } from "../protocol/types.js";
import { createSessionHealthTracker } from "./SessionHealthTracker.js";

// 会话级熔断的行为测试。真正要保证的是三件事：
//   1. 一个会话坏了不会把别的会话一起标成坏（故障隔离）；
//   2. 降级能自动恢复（不是一次失败定终身）；
//   3. 观测代码自己绝不抛异常（否则又变成「观测制造故障」）。

const compact = (status: "success" | "failed", preTokens = 86000): GatewayEvent => ({
  type: "agent_status",
  event: "compact_completed",
  detail: { status, trigger: "auto", preTokens },
});

const toolFail = (name = "bash"): GatewayEvent => ({
  type: "tool_call_finished",
  toolCallId: "call_1",
  ok: false,
  toolName: name,
});

const turnDone = (): GatewayEvent => ({ type: "turn_completed", usage: {}, finishReason: "end_turn" });

test("单次失败只记账，不降级（偶发抖动不该误伤）", () => {
  const tracker = createSessionHealthTracker();
  tracker.observe(compact("failed"), { sessionKey: "s1" });
  assert.equal(tracker.get("s1").state, "healthy");
  assert.equal(tracker.get("s1").failureTotal, 1);
});

test("连续失败到阈值才降级，并给出人能看懂的原因", () => {
  const degraded: string[] = [];
  const tracker = createSessionHealthTracker({ onDegrade: info => degraded.push(info.reason) });
  tracker.observe(compact("failed"), { sessionKey: "s1" });
  tracker.observe(compact("failed"), { sessionKey: "s1" });
  const snapshot = tracker.get("s1");
  assert.equal(snapshot.state, "degraded");
  assert.equal(snapshot.category, "compaction");
  assert.match(snapshot.reason ?? "", /上下文压缩失败/);
  assert.match(snapshot.reason ?? "", /86000 tokens/);
  assert.equal(degraded.length, 1, "只在状态翻转的那一刻通知一次");
});

test("故障只落在出问题的那个会话上（这就是熔断的全部意义）", () => {
  const tracker = createSessionHealthTracker();
  for (let i = 0; i < 3; i += 1) tracker.observe(compact("failed"), { sessionKey: "sick"});
  tracker.observe(compact("success"), { sessionKey: "healthy-one" });
  tracker.observe(turnDone(), { sessionKey: "healthy-one" });

  assert.equal(tracker.get("sick").state, "degraded");
  assert.equal(tracker.get("healthy-one").state, "healthy");

  const summary = tracker.snapshot();
  assert.equal(summary.sessions, 2);
  assert.equal(summary.degraded, 1);
  assert.equal(summary.scope, "partial", "局部故障必须被如实描述成局部");
  assert.equal(summary.degradedSessions[0]?.sessionKey, "sick");
});

test("全部会话一起坏时才报 all（用来区分「局部」和「网关整体不行了」）", () => {
  const tracker = createSessionHealthTracker();
  for (const key of ["a", "b"]) {
    tracker.observe(compact("failed"), { sessionKey: key });
    tracker.observe(compact("failed"), { sessionKey: key });
  }
  assert.equal(tracker.snapshot().scope, "all");
});

test("压缩成功 / 正常收尾会把降级中的会话拉回 healthy", () => {
  const recovered: string[] = [];
  const tracker = createSessionHealthTracker({ onRecover: info => recovered.push(info.sessionKey) });
  tracker.observe(compact("failed"), { sessionKey: "s1" });
  tracker.observe(compact("failed"), { sessionKey: "s1" });
  assert.equal(tracker.get("s1").state, "degraded");

  tracker.observe(compact("success"), { sessionKey: "s1" });
  assert.equal(tracker.get("s1").state, "healthy", "压缩恢复说明上下文压力已解除");
  assert.deepEqual(recovered, ["s1"]);
  // 历史账仍然留着：它发生过是事实，成功率要算进去。
  assert.equal(tracker.get("s1").compaction.failed, 2);
  assert.equal(tracker.get("s1").compaction.succeeded, 1);
});

test("一轮完整跑完也算康复信号", () => {
  const tracker = createSessionHealthTracker();
  tracker.observe(toolFail(), { sessionKey: "s1" });
  tracker.observe(toolFail(), { sessionKey: "s1" });
  assert.equal(tracker.get("s1").state, "degraded");
  tracker.observe(turnDone(), { sessionKey: "s1" });
  assert.equal(tracker.get("s1").state, "healthy");
  assert.equal(tracker.get("s1").turnTotal, 1);
});

test("工具失败用 ok:false 判定（上游没有 isError 字段）", () => {
  const tracker = createSessionHealthTracker();
  tracker.observe(toolFail("read_file"), { sessionKey: "s1" });
  tracker.observe(toolFail("read_file"), { sessionKey: "s1" });
  const snapshot = tracker.get("s1");
  assert.equal(snapshot.state, "degraded");
  assert.equal(snapshot.category, "tool");
  assert.match(snapshot.reason ?? "", /read_file/);
});

test("recoverable:true 的 error 不计入熔断（可恢复的不算病）", () => {
  const tracker = createSessionHealthTracker();
  for (let i = 0; i < 5; i += 1) {
    tracker.observe({ type: "error", message: "rate limited", recoverable: true }, { sessionKey: "s1" });
  }
  assert.equal(tracker.get("s1").state, "healthy");
  assert.equal(tracker.get("s1").failureTotal, 0);
});

test("recoverable:false 的 error 计入并带上 code", () => {
  const tracker = createSessionHealthTracker();
  tracker.observe({ type: "error", message: "上下文溢出", code: "context_overflow", recoverable: false }, { sessionKey: "s1" });
  tracker.observe({ type: "error", message: "上下文溢出", code: "context_overflow", recoverable: false }, { sessionKey: "s1" });
  const snapshot = tracker.get("s1");
  assert.equal(snapshot.category, "model");
  assert.match(snapshot.reason ?? "", /code=context_overflow/);
});

test("压缩成功率：没有样本时是 null，不是 100%", () => {
  const tracker = createSessionHealthTracker();
  assert.equal(tracker.snapshot().compaction.successRate, null);
  tracker.observe(compact("success"), { sessionKey: "s1" });
  tracker.observe(compact("failed"), { sessionKey: "s1" });
  tracker.observe(compact("failed"), { sessionKey: "s1" });
  assert.equal(tracker.snapshot().compaction.total, 3);
  assert.ok(Math.abs((tracker.snapshot().compaction.successRate ?? 0) - 1 / 3) < 1e-9);
});

test("未知会话查出来是 healthy，不炸", () => {
  const tracker = createSessionHealthTracker();
  assert.equal(tracker.get("never-seen").state, "healthy");
});

test("没有 sessionKey 的事件、不相关的事件都直接放过", () => {
  const tracker = createSessionHealthTracker();
  assert.deepEqual(tracker.observe(compact("failed"), {}), { changed: false });
  assert.deepEqual(tracker.observe({ type: "assistant_block", blockId: "b", kind: "text", text: "hi" }, { sessionKey: "s1" }), { changed: false });
  assert.equal(tracker.snapshot().sessions, 0);
});

test("外部可以显式登记降级（例如 bridge 发现网关不可用）", () => {
  const tracker = createSessionHealthTracker();
  tracker.markDegraded("s1", "external", "PilotDeck gateway is unavailable.");
  assert.equal(tracker.get("s1").state, "degraded");
  assert.match(tracker.get("s1").reason ?? "", /unavailable/);
  tracker.markRecovered("s1");
  assert.equal(tracker.get("s1").state, "healthy");
});

test("观测代码永不抛异常：坏事件、抛错的回调都吞得掉", () => {
  const tracker = createSessionHealthTracker({
    onDegrade: () => { throw new Error("回调故意炸"); },
    onRecover: () => { throw new Error("回调故意炸"); },
  });
  assert.doesNotThrow(() => tracker.observe(null as unknown as GatewayEvent, { sessionKey: "s1" }));
  assert.doesNotThrow(() => tracker.observe({ type: "agent_status" } as unknown as GatewayEvent, { sessionKey: "s1" }));
  assert.doesNotThrow(() => {
    tracker.observe(compact("failed"), { sessionKey: "s1" });
    tracker.observe(compact("failed"), { sessionKey: "s1" });
    tracker.observe(compact("success"), { sessionKey: "s1" });
  });
  assert.doesNotThrow(() => tracker.markDegraded("", "external", "空 key 应当被忽略"));
  assert.doesNotThrow(() => tracker.markRecovered("不存在的会话"));
  assert.doesNotThrow(() => tracker.snapshot());
});

test("静默够久的会话记录会被回收，Map 不会只增不减", () => {
  let clock = 0;
  const tracker = createSessionHealthTracker({ now: () => clock, recordTtlMs: 1000 });
  tracker.observe(compact("failed"), { sessionKey: "old" });
  clock = 5000;
  // 两次失败才降级，这里要的是「留下的是 fresh 而不是 old」这个证据。
  tracker.observe(compact("failed"), { sessionKey: "fresh" });
  tracker.observe(compact("failed"), { sessionKey: "fresh" });
  const summary = tracker.snapshot();
  assert.equal(summary.sessions, 1, "5 秒没动静的应当已经被回收");
  assert.equal(summary.degradedSessions[0]?.sessionKey, "fresh");
});