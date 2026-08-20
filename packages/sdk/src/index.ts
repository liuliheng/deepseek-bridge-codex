import { readFileSync } from "node:fs";
import { createConnection } from "node:net";
import type { Socket } from "node:net";
import { BridgeError, PROTOCOL_VERSION } from "../../protocol/src/index.ts";
import type { TaskEvent, TaskRecord } from "../../protocol/src/index.ts";

interface Response { id: number; result?: unknown; error?: { code: string; message: string; retryable: boolean; details?: Record<string, unknown> } }
export class BridgeClient {
  private socket?: Socket; private buffer = ""; private nextId = 1;
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: unknown) => void }>();
  readonly options: { socketPath: string; tokenPath: string; nodeId: string; kind: "codex" | "deepseek" | "user" };
  constructor(options: { socketPath: string; tokenPath: string; nodeId: string; kind: "codex" | "deepseek" | "user" }) { this.options = options; }
  async connect(): Promise<void> {
    if (this.socket && !this.socket.destroyed) return;
    this.socket = await new Promise<Socket>((resolve, reject) => { const socket = createConnection(this.options.socketPath); socket.once("connect", () => resolve(socket)); socket.once("error", reject); });
    this.socket.setEncoding("utf8"); this.socket.on("data", (chunk) => this.onData(chunk));
    this.socket.on("close", () => { for (const p of this.pending.values()) p.reject(new BridgeError("TARGET_OFFLINE", "Bridge 连接已断开", true)); this.pending.clear(); });
    const token = readFileSync(this.options.tokenPath, "utf8").trim();
    await this.raw("hello", { token, protocolVersion: PROTOCOL_VERSION, nodeId: this.options.nodeId, kind: this.options.kind, adapterVersion: "0.1.0" });
  }
  private onData(chunk: string): void {
    this.buffer += chunk; let newline: number;
    while ((newline = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, newline); this.buffer = this.buffer.slice(newline + 1); if (!line) continue;
      let response: Response; try { response = JSON.parse(line) as Response; } catch { continue; }
      const pending = this.pending.get(response.id); if (!pending) continue; this.pending.delete(response.id);
      if (response.error) pending.reject(new BridgeError(response.error.code, response.error.message, response.error.retryable, response.error.details)); else pending.resolve(response.result);
    }
  }
  private raw(type: string, payload: Record<string, unknown> = {}): Promise<unknown> {
    if (!this.socket?.writable) throw new BridgeError("TARGET_OFFLINE", "Bridge 尚未连接", true);
    const id = this.nextId++; this.socket.write(`${JSON.stringify({ id, type, payload })}\n`);
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
  async request<T = unknown>(type: string, payload: Record<string, unknown> = {}): Promise<T> { await this.connect(); return await this.raw(type, payload) as T; }
  async submit(task: Record<string, unknown>): Promise<{ task: TaskRecord; idempotent: boolean }> { return await this.request("task.submit", task); }
  async getTask(taskId: string): Promise<{ task: TaskRecord; events: TaskEvent[]; artifacts: unknown[] }> { return await this.request("task.get", { taskId }); }
  async waitTask(taskId: string, afterSeq = 0, timeoutMs = 30_000): Promise<{ task: TaskRecord; events: TaskEvent[]; artifacts: unknown[] }> {
    const deadline = Date.now() + Math.min(Math.max(timeoutMs, 0), 60_000);
    while (true) {
      const value = await this.getTask(taskId); const events = value.events.filter((event) => event.seq > afterSeq);
      if (events.length || ["SUCCEEDED", "FAILED", "CANCELED", "TIMED_OUT", "LOST"].includes(value.task.status) || Date.now() >= deadline) return { ...value, events };
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  close(): void { this.socket?.end(); }
}
