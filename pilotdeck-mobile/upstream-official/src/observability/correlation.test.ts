import test from "node:test";
import assert from "node:assert/strict";
import {
  CORRELATION_ID_HEADER,
  correlationIdFromHeaders,
  correlationPrefix,
  currentCorrelation,
  newCorrelationId,
  resolveCorrelationId,
  runWithCorrelation,
} from "./correlation.js";

test("生成的 id 是可 grep 的短串，且每次不同", () => {
  const ids = new Set<string>();
  for (let i = 0; i < 200; i += 1) {
    const id = newCorrelationId();
    assert.match(id, /^[A-Za-z0-9_-]{6,64}$/, `unexpected shape: ${id}`);
    ids.add(id);
  }
  assert.equal(ids.size, 200);
});

test("客户端自带的 id 原样采用，便于跨服务对齐", () => {
  assert.equal(resolveCorrelationId("deploy-2026-11-08-a"), "deploy-2026-11-08-a");
});

test("不安全的 id 一律丢弃并自己生成：日志里不能出现任意输入", () => {
  const unsafe = [
    "",
    "ab",                                    // 太短，grep 时全是噪音
    "a".repeat(200),                          // 超长
    "corr with spaces",
    "ok\n[pilotdeck] fake log line",          // 日志注入
    "ok\u001b[31mred\u001b[0m",               // ANSI 注入
    "../etc/passwd",
    "中文设备名",
    "  spa ce  ",                             // 去首尾空格后中间仍有空格
    undefined,
    null,
    42,
    { correlationId: "nested" },
  ];
  for (const value of unsafe) {
    const resolved = resolveCorrelationId(value);
    assert.match(resolved, /^[A-Za-z0-9_-]{6,64}$/, `accepted unsafe value: ${String(value)}`);
    // 落进日志的是 resolved，所以危险字符必须在这里就已经不存在
    assert.ok(!resolved.includes("\n") && !resolved.includes("\u001b"));
  }
});

test("id 能穿过 await 被读到（这才是 AsyncLocalStorage 的意义）", async () => {
  await runWithCorrelation({ correlationId: "aaaa11", sessionKey: "web:s_1" }, async () => {
    await new Promise((resolve) => setTimeout(resolve, 1));
    assert.deepEqual(currentCorrelation(), { correlationId: "aaaa11", sessionKey: "web:s_1" });
    await runWithCorrelation({ correlationId: "bbbb22", sessionKey: "web:s_2" }, async () => {
      assert.equal(currentCorrelation()?.correlationId, "bbbb22");
    });
    // 内层退出后必须回到外层，而不是留下污染
    assert.equal(currentCorrelation()?.correlationId, "aaaa11");
  });
  assert.equal(currentCorrelation(), null);
});

test("前缀带上 corr 与 session，能被单条 grep 捞回整条链路", () => {
  runWithCorrelation({ correlationId: "cccc33", sessionKey: "web:s_9" }, () => {
    assert.equal(correlationPrefix(), "[corr=cccc33 session=web:s_9] ");
  });
  assert.equal(correlationPrefix({ correlationId: "dddd44" }), "[corr=dddd44] ");
  assert.equal(correlationPrefix({ sessionKey: "s" }), "[session=s] ");
});

test("不在任何上下文里时前缀是空串而不是 undefined 文本", () => {
  assert.equal(currentCorrelation(), null);
  assert.equal(correlationPrefix(), "");
});

test("前缀永不抛：它站在 catch 块和事件流主路径上", () => {
  const junk: unknown[] = [null, undefined, {}, { correlationId: 42 }, { correlationId: {} }, [], "string"];
  for (const value of junk) {
    assert.equal(typeof correlationPrefix(value as never), "string");
  }
});

test("runWithCorrelation 不吞异常：回调抛的栈原样出来", async () => {
  class BoomError extends Error {
    override name = "BoomError";
  }
  await assert.rejects(
    runWithCorrelation({ correlationId: "eeee55" }, async () => {
      await Promise.resolve();
      throw new BoomError("boom");
    }),
    (error: unknown) => {
      assert.ok(error instanceof BoomError);
      assert.match(String((error as Error).stack), /BoomError: boom/);
      return true;
    },
  );
});

test("HTTP 头取值：Node 已把头转小写，且可能是数组", () => {
  assert.equal(correlationIdFromHeaders({ [CORRELATION_ID_HEADER]: "from-header-1" }), "from-header-1");
  assert.equal(correlationIdFromHeaders({ [CORRELATION_ID_HEADER]: ["first-11", "second-22"] }), "first-11");
  const forged = correlationIdFromHeaders({ [CORRELATION_ID_HEADER]: "bad id\n[inject]" });
  assert.match(forged, /^[A-Za-z0-9_-]{6,64}$/);
  assert.equal(correlationIdFromHeaders(undefined).length > 0, true);
  assert.equal(correlationIdFromHeaders({}).length > 0, true);
});
