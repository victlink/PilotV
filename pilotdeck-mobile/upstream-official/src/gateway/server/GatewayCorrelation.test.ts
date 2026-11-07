import assert from "node:assert/strict";
import { test } from "node:test";
import type { Gateway } from "../protocol/types.js";
import { startGatewayServer } from "./GatewayServer.js";
import { resetSessionHealthTracker } from "../health/gatewayHealth.js";
import { CORRELATION_ID_HEADER } from "../../observability/correlation.js";

// 这份测试守的是「一次失败到底能不能被追到」。缺陷 B 排了三轮，
// 卡点不是没有日志，而是前端那次失败和服务端那行日志之间没有任何共同字段。
// 所以这里断言的是端到端：从 ws 帧里能读到 id，日志里也带着同一个 id。

type Frame = { type: string; id?: string; correlationId?: string; ok?: boolean; result?: unknown; error?: { code?: string; message?: string }; event?: { type?: string; sessionKey?: string } };

const PROTOCOL = "1.1";

type Harness = {
  url: string;
  token: string;
  logs: { message: string; error?: unknown }[];
  close(): Promise<void>;
};

/** 握手固定会调 describeServer，所以每个用例都得有它；其余方法留给用例自己决定成败。 */
const baseGateway = (): Partial<Gateway> => ({
  describeServer: async () => ({ mode: "in_process" as const, protocolVersion: "1.1" }),
});

async function start(gateway: Partial<Gateway> = {}): Promise<Harness> {
  const logs: { message: string; error?: unknown }[] = [];
  // 用真 HTTP + 真 WebSocket 跑，而不是直接调私有方法：接线接错才是最常见的失败方式。
  const real = await startGatewayServer({
    gateway: { ...baseGateway(), ...gateway } as Gateway,
    port: 0,
    token: "test-token",
    serverVersion: "test",
    log: (message, error) => logs.push({ message, error }),
  });
  return {
    url: real.wsUrl,
    token: real.token,
    logs,
    close: async () => { await real.close(); resetSessionHealthTracker(); },
  };
}

function connect(url: string, headers?: Record<string, string>): Promise<{
  send(payload: unknown): void;
  next(timeoutMs?: number): Promise<Frame>;
  close(): void;
}> {
  return new Promise((resolve, reject) => {
    // Node 的 WebSocket 支持 headers，lib.dom 的类型签名里没有这一维
    const ws = new WebSocket(url, { headers } as unknown as string[]);
    const queue: Frame[] = [];
    const waiters: ((frame: Frame) => void)[] = [];
    ws.addEventListener("message", (event) => {
      const frame = JSON.parse(String(event.data)) as Frame;
      const waiter = waiters.shift();
      if (waiter) waiter(frame);
      else queue.push(frame);
    });
    ws.addEventListener("error", () => reject(new Error("websocket connect failed")));
    ws.addEventListener("open", () => resolve({
      send: (payload) => ws.send(JSON.stringify(payload)),
      next: (timeoutMs = 4000) => new Promise<Frame>((resolveFrame, rejectFrame) => {
        const pending = queue.shift();
        if (pending) { resolveFrame(pending); return; }
        const timer = setTimeout(() => rejectFrame(new Error("timed out waiting for a ws frame")), timeoutMs);
        waiters.push((frame) => { clearTimeout(timer); resolveFrame(frame); });
      }),
      close: () => ws.close(),
    }));
  });
}

async function handshake(client: Awaited<ReturnType<typeof connect>>, token: string): Promise<void> {
  client.send({ type: "hello", protocolVersion: PROTOCOL, clientName: "test", clientVersion: "0.0.0", token });
  const hello = await client.next();
  assert.equal(hello.type, "hello_ok");
}

test("HTTP 响应带回调关联头：客户端能把它的界面报错和某一行人日志对上", async () => {
  const server = await startGatewayServer({ gateway: {} as Gateway, port: 0, token: "t", serverVersion: "test" });
  try {
    const response = await fetch(`${server.url}/health`, { headers: { [CORRELATION_ID_HEADER]: "curl-trace-01" } });
    assert.equal(response.headers.get(CORRELATION_ID_HEADER), "curl-trace-01");
    const auto = await fetch(`${server.url}/health`);
    assert.match(auto.headers.get(CORRELATION_ID_HEADER) ?? "", /^[A-Za-z0-9_-]{6,64}$/, "没带就该自己生成一个");
  } finally {
    await server.close();
  }
});

test("客户端自带的 id 会出现在每一个响应帧上（成功与失败都是）", async () => {
  resetSessionHealthTracker();
  const harness = await start();
  const client = await connect(harness.url);
  try {
    await handshake(client, harness.token);
    // 这个方法在空 gateway 上必定失败，正好用来检查失败帧
    client.send({ type: "request", id: "r1", method: "close_project_sessions", params: { correlationId: "trace-aaaa" } });
    const failure = await client.next();
    assert.equal(failure.type, "response");
    assert.equal(failure.id, "r1");
    assert.equal(failure.ok, false);
    assert.equal(failure.correlationId, "trace-aaaa", "失败帧没有 id，就等于让前端报错无法回查");
  } finally {
    client.close();
    await harness.close();
  }
});

test("没带 id 时服务端自己生成，且响应与日志用的是同一个", async () => {
  resetSessionHealthTracker();
  const harness = await start();
  const client = await connect(harness.url);
  try {
    await handshake(client, harness.token);
    client.send({ type: "request", id: "r2", method: "close_project_sessions", params: {} });
    const failure = await client.next();
    const issued = failure.correlationId ?? "";
    assert.match(issued, /^[A-Za-z0-9_-]{6,64}$/);
    assert.equal(failure.ok, false);
  } finally {
    client.close();
    await harness.close();
  }
});

test("连接级 id 来自 upgrade 请求头，并被截断成不带凭据风险的短形式", async () => {
  resetSessionHealthTracker();
  const harness = await start({ describeServer: async () => ({ mode: "in_process" as const, protocolVersion: "1.1" }) });
  const client = await connect(harness.url, { [CORRELATION_ID_HEADER]: "upgraded-conn-id-01" });
  try {
    await handshake(client, harness.token);
    client.send({ type: "request", id: "r3", method: "describe_server", params: {} });
    const ok = await client.next();
    assert.equal(ok.ok, true, "带自定义头不该把连接搞坏");
  } finally {
    client.close();
    await harness.close();
  }
});

test("失败必须在日志里留下同一个 id 和完整堆栈（telemetry 只上报，不许替日志）", async () => {
  resetSessionHealthTracker();
  const harness = await start();
  const client = await connect(harness.url);
  try {
    await handshake(client, harness.token);
    client.send({ type: "request", id: "r5", method: "close_project_sessions", params: { sessionKey: "web:s_zzz", correlationId: "trace-cc" } });
    const failure = await client.next();
    assert.equal(failure.ok, false);
    assert.equal(failure.correlationId, "trace-cc");

    // 这一条是整件事的重点：前端拿到 trace-cc，服务端日志里就得能 grep 到它。
    const line = harness.logs.find(entry => String(entry.message).includes("trace-cc"));
    assert.ok(line, `日志里没有关联 id。实际日志：${JSON.stringify(harness.logs.map(entry => entry.message))}`);
    assert.match(String(line.message), /corr=trace-cc/);
    assert.match(String(line.message), /session=web:s_zzz/, "得说清是哪条会话在坏，不是只说「出错了」");
    assert.match(String(line.message), /method=close_project_sessions/);
    // 堆栈不能只剩 telemetry 那行 —— 缺陷 B 前两轮就栽在这里
    assert.ok(line.error instanceof Error, "原始错误对象必须原样交给日志，不能被压成字符串或 code");
    // 要断言的是「栈还在」，不是某一个具体错误：telemetry 会把错误压成 code，
    // 而 code 里没有调用链 —— 缺陷 B 缺的正是这一段。
    assert.match(String(line.error.stack), /Error: Project session closure is unavailable\./);
    assert.match(String(line.error.stack), /\n\s+at /, "只有 message 没有栈帧，等于没留堆栈");
  } finally {
    client.close();
    await harness.close();
  }
});

test("日志出口自己出问题也不能把请求带下去（观测代码不许具备杀伤力）", async () => {
  resetSessionHealthTracker();
  const server = await startGatewayServer({
    gateway: { describeServer: async () => ({ mode: "in_process" as const }) } as Gateway,
    port: 0,
    token: "test-token",
    serverVersion: "test",
    log: () => { throw new Error("日志器炸了"); },
  });
  const client = await connect(server.wsUrl);
  try {
    await handshake(client, server.token);
    client.send({ type: "request", id: "r6", method: "close_project_sessions", params: { sessionKey: "web:s_yyy" } });
    const failure = await client.next();
    assert.equal(failure.ok, false, "请求本身该如实失败");
    assert.ok(failure.correlationId, "即使日志器炸了，id 仍要回传");
  } finally {
    client.close();
    await server.close();
    resetSessionHealthTracker();
  }
});
