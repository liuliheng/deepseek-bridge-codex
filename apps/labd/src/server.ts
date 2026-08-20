import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import type { Server, Socket } from "node:net";
import { dirname } from "node:path";
import { BridgeError, PROTOCOL_VERSION, asBridgeError } from "../../../packages/protocol/src/index.ts";
import { TaskRouter } from "./router.ts";
import type { LabConfig } from "./config.ts";

interface RequestMessage { id: string | number; type: string; payload?: Record<string, unknown> }
interface ClientContext { authenticated: boolean; consumerId: string; kind?: "codex" | "deepseek" | "user"; buffer: string }

function loadOrCreateToken(path: string): string {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  if (!existsSync(path)) writeFileSync(path, randomBytes(32).toString("hex"), { mode: 0o600, flag: "wx" });
  chmodSync(path, 0o600); return readFileSync(path, "utf8").trim();
}
function tokenEqual(expected: string, actual: unknown): boolean {
  if (typeof actual !== "string") return false; const a = createHash("sha256").update(expected).digest(), b = createHash("sha256").update(actual).digest(); return timingSafeEqual(a, b);
}

export class IpcServer {
  private server?: Server; private readonly token: string;
  private readonly sockets = new Set<Socket>();
  private readonly config: LabConfig; private readonly router: TaskRouter;
  constructor(config: LabConfig, router: TaskRouter) { this.config = config; this.router = router; this.token = loadOrCreateToken(config.tokenPath); }
  async start(): Promise<void> {
    mkdirSync(dirname(this.config.socketPath), { recursive: true, mode: 0o700 });
    if (existsSync(this.config.socketPath)) unlinkSync(this.config.socketPath);
    this.server = createServer((socket) => this.handle(socket));
    await new Promise<void>((resolve, reject) => { this.server!.once("error", reject); this.server!.listen(this.config.socketPath, resolve); });
    chmodSync(this.config.socketPath, 0o600);
  }
  private handle(socket: Socket): void {
    this.sockets.add(socket);
    const context: ClientContext = { authenticated: false, consumerId: "anonymous", buffer: "" };
    socket.setEncoding("utf8"); socket.on("close", () => { this.sockets.delete(socket); if (context.authenticated) { try { this.router.store.disconnect(context.consumerId); } catch {} } }); socket.on("data", (chunk) => {
      context.buffer += chunk;
      if (Buffer.byteLength(context.buffer) > this.config.maxMessageBytes) { this.reply(socket, null, undefined, new BridgeError("MESSAGE_TOO_LARGE", "控制消息超过大小限制")); socket.destroy(); return; }
      let newline: number;
      while ((newline = context.buffer.indexOf("\n")) >= 0) {
        const line = context.buffer.slice(0, newline); context.buffer = context.buffer.slice(newline + 1); if (!line.trim()) continue;
        void this.process(socket, context, line);
      }
    });
  }
  private async process(socket: Socket, context: ClientContext, line: string): Promise<void> {
    let request: RequestMessage;
    try { request = JSON.parse(line) as RequestMessage; if (request.id === undefined || typeof request.type !== "string") throw new BridgeError("INVALID_REQUEST", "消息缺少 id 或 type"); }
    catch (error) { this.reply(socket, null, undefined, asBridgeError(error)); return; }
    try {
      if (!context.authenticated) {
        if (request.type !== "hello" || !tokenEqual(this.token, request.payload?.token)) throw new BridgeError("AUTH_FAILED", "Bridge 鉴权失败");
        if (request.payload?.protocolVersion !== PROTOCOL_VERSION) throw new BridgeError("PROTOCOL_VERSION_UNSUPPORTED", "协议版本不兼容", false, { supported: PROTOCOL_VERSION });
        if (!["codex", "deepseek", "user"].includes(String(request.payload?.kind))) throw new BridgeError("AUTH_FAILED", "节点 kind 无效");
        context.authenticated = true; context.consumerId = String(request.payload?.nodeId ?? "anonymous"); context.kind = request.payload?.kind as ClientContext["kind"];
        this.router.store.upsertConnection({ nodeId: context.consumerId, kind: context.kind!, adapterVersion: typeof request.payload?.adapterVersion === "string" ? request.payload.adapterVersion : undefined, runtimeVersion: typeof request.payload?.runtimeVersion === "string" ? request.payload.runtimeVersion : undefined, capabilities: request.payload?.capabilities });
        this.reply(socket, request.id, { protocolVersion: PROTOCOL_VERSION, nodeId: "labd-local", capabilities: this.router.capabilities() }); return;
      }
      this.router.store.touchConnection(context.consumerId);
      const p = request.payload ?? {}; let result: unknown;
      switch (request.type) {
        case "health": result = { status: "ok", protocolVersion: PROTOCOL_VERSION, acceptingTasks: this.router.acceptingTasks, metrics: this.router.store.metrics() }; break;
        case "capabilities.list": result = this.router.capabilities(); break;
        case "connections.list": result = this.router.store.connections(); break;
        case "task.submit": {
          if (p.sourceAgent !== context.kind) throw new BridgeError("AUTH_FAILED", "任务 sourceAgent 与已认证节点身份不一致", false, { authenticatedKind: context.kind });
          result = this.router.submit(p); break;
        }
        case "task.get": result = this.router.get(String(p.taskId)); break;
        case "task.list": result = this.router.list({ status: p.status as never, limit: Number(p.limit ?? 50) }); break;
        case "task.retry": result = this.router.retry(String(p.taskId), context.kind!, typeof p.idempotencyKey === "string" ? p.idempotencyKey : undefined); break;
        case "task.events": result = this.router.events(String(p.taskId), Number(p.afterSeq ?? 0)); break;
        case "event.ack": result = { throughSeq: this.router.ack(context.consumerId, String(p.taskId), Number(p.throughSeq)) }; break;
        case "task.cancel": result = await this.router.cancel(String(p.taskId), context.consumerId, typeof p.reason === "string" ? p.reason : undefined); break;
        case "task.input": await this.router.sendInput(String(p.taskId), p.input); result = { accepted: true }; break;
        case "approval.list": result = this.router.store.listApprovals(typeof p.status === "string" ? p.status : undefined); break;
        case "approval.decide": result = await this.router.decideApproval(String(p.approvalId), Boolean(p.approved), context.consumerId, typeof p.reason === "string" ? p.reason : undefined); break;
        case "bridge.stop": await this.router.killSwitch(context.consumerId, typeof p.reason === "string" ? p.reason : undefined); result = { stopped: true }; break;
        case "bridge.resume": this.router.resumeAccepting(); result = { stopped: false }; break;
        default: throw new BridgeError("METHOD_NOT_FOUND", `未知消息类型：${request.type}`);
      }
      this.reply(socket, request.id, result);
    } catch (error) { this.reply(socket, request.id, undefined, asBridgeError(error)); }
  }
  private reply(socket: Socket, id: string | number | null, result?: unknown, error?: BridgeError): void {
    socket.write(`${JSON.stringify({ id, ...(error ? { error: error.toJSON() } : { result }) })}\n`);
  }
  async close(): Promise<void> {
    await new Promise<void>((resolve) => {
      if (!this.server) { resolve(); return; }
      this.server.close(() => resolve());
      for (const socket of this.sockets) socket.destroy();
    });
    this.sockets.clear();
    if (existsSync(this.config.socketPath)) unlinkSync(this.config.socketPath);
  }
}
