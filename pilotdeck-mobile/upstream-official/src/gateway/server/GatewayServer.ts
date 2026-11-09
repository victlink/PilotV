import { existsSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import type { Duplex } from "node:stream";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { requestContextHeaders, safeHeaderValue, withRequestContext } from "../../network/requestContext.js";
import type { Gateway } from "../protocol/types.js";
import { createWebSocketAcceptValue, TextWebSocketConnection } from "./websocket.js";
import { GatewayWsConnection } from "./GatewayWsConnection.js";
import { ensureGatewayAuthToken } from "./authToken.js";
import { serveStaticAsset } from "./staticAssets.js";
import { handleWebApiRequest } from "../../adapters/web/httpRouter.js";
import { buildGatewayHealthPayload } from "../health/gatewayHealth.js";
import { CORRELATION_ID_HEADER, correlationIdFromHeaders } from "../../observability/correlation.js";

export type GatewayServerOptions = {
  gateway: Gateway;
  port?: number;
  host?: string;
  token?: string;
  staticAssetsPath?: string;
  serverVersion?: string;
  feishuWebhook?: (request: IncomingMessage, response: ServerResponse, body: string) => Promise<boolean> | boolean;
  /**
   * Resolves a `projectKey` (as supplied by the Web UI) to an absolute
   * project root. If unset, the projectKey is used verbatim as the root.
   */
  resolveProject?: (projectKey: string) => string;
  /**
   * 连接的日志出口。默认真 console.error；可注入是为了让测试能断言
   * 「失败确实留下了一行带关联 id 的日志」，而不是只在注释里承诺。
   */
  log?: (message: string, error?: unknown) => void;
};

export type GatewayServer = {
  /** Actual bound port, including default HTTP ports and ephemeral allocation. */
  port: number;
  url: string;
  wsUrl: string;
  token: string;
  tokenPath?: string;
  close(): Promise<void>;
  broadcastNotification(name: string, payload?: unknown): void;
};

export async function startGatewayServer(options: GatewayServerOptions): Promise<GatewayServer> {
  const host = options.host ?? "127.0.0.1";
  if (host !== "127.0.0.1" && host !== "localhost") {
    throw new Error("GatewayServer only supports localhost binding in the first phase.");
  }
  const auth = options.token
    ? { token: options.token, tokenPath: undefined }
    : await ensureGatewayAuthToken();

  const connections = new Set<GatewayWsConnection>();

  const server = createServer((request, response) => {
    void handleHttpRequest(request, response, options, auth.token, connections);
  });
  server.on("upgrade", (request, socket) =>
    handleUpgrade(request, socket, options, auth.token, connections),
  );

  await listen(server, options.port ?? 18789, host);
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : options.port ?? 18789;
  return {
    port,
    url: `http://${host}:${port}`,
    wsUrl: `ws://${host}:${port}/ws`,
    token: auth.token,
    tokenPath: auth.tokenPath,
    close: () => close(server),
    broadcastNotification(name: string, payload?: unknown) {
      for (const conn of connections) {
        conn.sendNotification(name, payload);
      }
    },
  };
}

async function handleHttpRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: GatewayServerOptions,
  token: string,
  connections: Set<GatewayWsConnection>,
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  response.setHeader(CORRELATION_ID_HEADER, correlationIdFromHeaders(request.headers));
  if (url.pathname === "/health") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true }));
    return;
  }
  // /healthz 与 /health 的区别：/health 只回答「端口有人应」，
  // /healthz 回答「这个进程还干活吗」——会话是不是在批量失败、ws 掉了几个、
  // 压缩成功率多少。supervisor 靠它决定要不要重启，doctor 靠它点名。
  // 保持永不 5xx：健康检查返回非 200 时，多数探活工具会把整个进程判死，
  // 而局部会话降级并不值得重启网关（重启也治不好）。
  if (url.pathname === "/healthz") {
    const payload = buildGatewayHealthPayload({
      wsConnections: connections.size,
      staticAssetsReady: options.staticAssetsPath ? existsSync(options.staticAssetsPath) : undefined,
      serverVersion: options.serverVersion,
    });
    response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    response.end(JSON.stringify(payload));
    return;
  }
  if (url.pathname === "/auth/local-token") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ token }));
    return;
  }
  if (url.pathname === "/feishu/webhook" && options.feishuWebhook) {
    const body = await readBody(request);
    const handled = await options.feishuWebhook(request, response, body);
    if (handled) {
      return;
    }
  }
  if (url.pathname.startsWith("/api/web/")) {
    const handled = await handleWebApiRequest(request, response, {
      gateway: options.gateway,
      token,
      resolveProject: options.resolveProject,
    });
    if (handled) {
      return;
    }
  }
  if (options.staticAssetsPath && serveStaticAsset(resolve(options.staticAssetsPath), url.pathname, response)) {
    return;
  }
  response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  response.end("not found");
}

function handleUpgrade(
  request: IncomingMessage,
  socket: Duplex,
  options: GatewayServerOptions,
  token: string,
  connections: Set<GatewayWsConnection>,
): void {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  if (url.pathname !== "/ws") {
    socket.destroy();
    return;
  }
  const key = request.headers["sec-websocket-key"];
  if (typeof key !== "string") {
    socket.destroy();
    return;
  }
  socket.write(
    [
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${createWebSocketAcceptValue(key)}`,
      "",
      "",
    ].join("\r\n"),
  );
  const ws = new TextWebSocketConnection(socket as Socket);
  const conn = new GatewayWsConnection(ws, {
    gateway: options.gateway,
    token,
    serverVersion: options.serverVersion ?? "0.1.0",
    // 浏览器建 ws 时带不上自定义头，所以这里多半是自动生成；
    // 网关自己发起的连接（CLI/TUI）会带，于是两条链路能并进同一份日志里查。
    connectionId: correlationIdFromHeaders(request.headers),
    log: options.log ?? ((message, error) => (error === undefined ? console.error(message) : console.error(message, error))),
  });
  connections.add(conn);
  conn.onClose(() => connections.delete(conn));
}

function listen(server: Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}
