import { BridgeClient } from "../../packages/sdk/src/index.ts";
import { loadConfig } from "../../apps/labd/src/config.ts";
import { mkdirSync, openSync, closeSync, unlinkSync } from "node:fs";
import { spawn } from "node:child_process";
import { basename, extname, resolve } from "node:path";

type JsonRpc = { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown>; result?: unknown; error?: unknown };
const target = process.argv.includes("--target=codex") ? "codex" : "deepseek";
const source = target === "codex" ? "deepseek" : "codex";
const directOnly = process.env.LAB_MCP_DIRECT_ONLY === "true" || process.env.LAB_MCP_IMAGE_ONLY === "true";
const config = loadConfig(process.env.LAB_PROJECT_ROOT ?? process.cwd());
const client = new BridgeClient({ socketPath: config.socketPath, tokenPath: config.tokenPath, nodeId: `${source}-bridge-mcp`, kind: source });

async function ensureBridge(): Promise<void> {
  try { await client.request("health"); return; } catch {}
  const projectRoot = process.env.LAB_PROJECT_ROOT ?? process.cwd();
  mkdirSync(resolve(projectRoot, ".lab-data"), { recursive: true, mode: 0o700 });
  const lockPath = resolve(projectRoot, ".lab-data", "autostart.lock"); let ownsLock = false;
  try { const fd = openSync(lockPath, "wx", 0o600); closeSync(fd); ownsLock = true; } catch {}
  if (ownsLock) {
    const daemon = spawn(process.execPath, [resolve(projectRoot, "apps/labd/src/main.ts")], {
      cwd: projectRoot, detached: true, stdio: "ignore", env: { ...process.env, LAB_PROJECT_ROOT: projectRoot },
    });
    daemon.unref();
  }
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
    try {
      await client.request("health");
      if (ownsLock) { try { unlinkSync(lockPath); } catch {} }
      return;
    } catch {}
  }
  if (ownsLock) { try { unlinkSync(lockPath); } catch {} }
  throw new Error(`Local Agent Bridge 未能启动；请检查 ${resolve(projectRoot, ".lab-data")}`);
}

const taskSchema = {
  type: "object", additionalProperties: false,
  required: ["idempotencyKey", "objective", "workspaceRoot", "capabilities", "acceptanceCriteria"],
  properties: {
    idempotencyKey: { type: "string", minLength: 1 }, objective: { type: "string", minLength: 1 },
    workspaceRoot: { type: "string", minLength: 1 }, allowedWriteRoots: { type: "array", items: { type: "string" }, default: [] },
    capabilities: { type: "array", items: { enum: ["read_files", "write_files", "shell", "network", "image_generate", "delegate"] } },
    inputs: { type: "array", items: { type: "object" }, default: [] }, artifacts: { type: "object" },
    acceptanceCriteria: { type: "array", items: { type: "string" } }, sessionPolicy: { enum: ["new", "resume", "fork"], default: "new" },
    sessionId: { type: "string" }, limits: { type: "object" }, originTaskId: { type: "string" }, parentTaskId: { type: "string" },
    delegationDepth: { type: "integer", minimum: 0 }, delegationChain: { type: "array", items: { type: "object" } },
  },
};
const prefix = target;
const imageTool = {
    name: "codex_generate_image",
    description: "Codex 图片直达工具。当用户说‘请使用 Codex 给我生成一张图片’或同义表达时，必须立刻调用；即使没有主题、风格或尺寸，也不要提问，使用默认提示词即可。它会让 Codex 新建独立会话，向 Codex 大模型发送请求，等待真实图片文件完成并返回绝对路径、MIME、大小和 SHA-256；不得先查询能力，不得用文本或伪文件代替图片。",
    inputSchema: {
      type: "object", additionalProperties: false,
      properties: {
        prompt: { type: "string", minLength: 1, default: "帮我生成一张图片", description: "完整图片生成要求；用户未提供细节时使用‘帮我生成一张图片’" },
        aspectRatio: { type: "string", description: "例如 1:1、16:9、9:16" },
        format: { enum: ["png", "jpg", "jpeg"], default: "png" },
        fileName: { type: "string", description: "可选文件名；只能是普通文件名" },
        outputDirectory: { type: "string", description: "可选绝对输出目录；默认写入本项目 .lab-artifacts/images" },
      },
    },
  };
const directTool = {
  name: target === "codex" ? "codex_do_work" : "deepseek_do_work",
  description: target === "codex"
    ? "Codex 通用直达工具。仅当用户在当前请求中以肯定、直接的方式指定 Codex 为任务执行者（如‘让 Codex 完成这个任务’）时调用。仅提及、讨论、引用、比较或否定 Codex，以及让 Harness 自己修复 Codex 相关代码或桥接问题，均不得触发。确认是直接委派后，把完整原始任务交给新的 Codex 会话并等待完成；图片任务优先使用 codex_generate_image。"
    : "DeepSeek Harness（DSH）通用直达工具。仅当用户在当前请求中以肯定、直接的方式指定 DSH / DeepSeek Harness / DeepSeek 为任务执行者（如‘让 DeepSeek 完成这个任务’）时调用。仅提及、讨论、引用、比较或否定这些名称，以及让 Codex 自己修复 DeepSeek 相关代码或桥接问题，均不得触发。确认是直接委派后，把完整原始任务交给真实 dsh headless 会话并等待完成。",
  inputSchema: {
    type: "object", additionalProperties: false,
    properties: {
      task: { type: "string", minLength: 1, description: "用户要求目标代理完成的原始任务；无额外细节时原样转发用户消息" },
      workspaceRoot: { type: "string", description: "绝对工作目录；默认使用 Bridge 项目目录" },
      allowedWriteRoots: { type: "array", items: { type: "string" }, description: "允许写入的绝对目录；默认仅工作目录" },
      capabilities: { type: "array", items: { enum: ["read_files", "write_files", "shell", "network", "image_generate", "delegate"] }, description: "可选最小能力集合" },
      acceptanceCriteria: { type: "array", items: { type: "string" }, description: "可选完成标准" },
    },
  },
};
const bridgeTools = [
  { name: `${prefix}_submit_task`, description: `向 ${target} 提交受权限约束的持久任务`, inputSchema: taskSchema },
  { name: `${prefix}_get_task`, description: "获取任务、事件和产物", inputSchema: { type: "object", required: ["taskId"], properties: { taskId: { type: "string" } } } },
  { name: `${prefix}_wait_task`, description: "等待任务出现新事件或进入终态", inputSchema: { type: "object", required: ["taskId"], properties: { taskId: { type: "string" }, afterSeq: { type: "integer", minimum: 0 }, timeoutMs: { type: "integer", minimum: 0, maximum: 60000 } } } },
  { name: `${prefix}_send_input`, description: "向运行中的任务追加指导", inputSchema: { type: "object", required: ["taskId", "input"], properties: { taskId: { type: "string" }, input: {} } } },
  { name: `${prefix}_cancel_task`, description: "取消任务", inputSchema: { type: "object", required: ["taskId"], properties: { taskId: { type: "string" }, reason: { type: "string" } } } },
  { name: "bridge_list_capabilities", description: "查询双方 runtime 在线状态与能力", inputSchema: { type: "object", properties: {} } },
];
const tools = [...(target === "codex" ? [imageTool] : []), directTool, ...(directOnly ? [] : bridgeTools)];

function respond(message: JsonRpc): void { process.stdout.write(`${JSON.stringify(message)}\n`); }
const ok = (id: JsonRpc["id"], value: unknown) => respond({ jsonrpc: "2.0", id, result: value });
const fail = (id: JsonRpc["id"], error: unknown) => respond({ jsonrpc: "2.0", id, error: { code: -32000, message: error instanceof Error ? error.message : String(error) } });
async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  await ensureBridge();
  if (name === directTool.name) {
    const projectRoot = process.env.LAB_PROJECT_ROOT ?? process.cwd();
    const workspaceRoot = typeof args.workspaceRoot === "string" ? resolve(args.workspaceRoot) : resolve(process.env.LAB_DEFAULT_WORKSPACE ?? projectRoot);
    const taskText = String(args.task ?? (target === "codex" ? "请使用 Codex 完成用户指定的任务" : "请使用 DeepSeek Harness 完成用户指定的任务")).trim();
    const writeRoots = Array.isArray(args.allowedWriteRoots)
      ? args.allowedWriteRoots.map((item) => resolve(String(item))) : [workspaceRoot];
    const requestedCapabilities = Array.isArray(args.capabilities) ? args.capabilities.map(String) : ["read_files", "write_files", "shell"];
    const capabilities = requestedCapabilities.filter((item, index) => requestedCapabilities.indexOf(item) === index);
    const acceptanceCriteria = Array.isArray(args.acceptanceCriteria) && args.acceptanceCriteria.length > 0
      ? args.acceptanceCriteria.map(String) : ["目标代理实际执行任务并返回结果"];
    const accepted = await client.submit({
      idempotencyKey: `${source}:${target}:direct:${Date.now()}`,
      sourceAgent: source, targetAgent: target,
      objective: taskText,
      sessionPolicy: "new", workspaceRoot, allowedWriteRoots: writeRoots,
      capabilities: capabilities as Array<"read_files" | "write_files" | "shell" | "network" | "image_generate" | "delegate">,
      inputs: [{ type: "text", text: taskText }], acceptanceCriteria,
      limits: { queueTimeoutMs: 600_000, runTimeoutMs: 600_000, maxDelegationDepth: 3 },
    });
    let detail = await client.getTask(accepted.task.id); const deadline = Date.now() + 610_000;
    while (!["SUCCEEDED", "FAILED", "CANCELED", "TIMED_OUT", "LOST"].includes(detail.task.status) && Date.now() < deadline) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 500)); detail = await client.getTask(accepted.task.id);
    }
    if (detail.task.status !== "SUCCEEDED") throw new Error(`${target} 任务未成功：${detail.task.status} — ${detail.task.result?.summary ?? "无结果"}`);
    return { taskId: detail.task.id, status: detail.task.status, summary: detail.task.result?.summary, output: detail.task.result?.output, artifacts: detail.artifacts };
  }
  if (name === "codex_generate_image" && target === "codex") {
    const projectRoot = process.env.LAB_PROJECT_ROOT ?? process.cwd();
    const workspaceRoot = process.env.LAB_DEFAULT_WORKSPACE ?? projectRoot;
    const outputDirectory = typeof args.outputDirectory === "string" ? resolve(args.outputDirectory) : resolve(projectRoot, ".lab-artifacts", "images");
    const format = ["png", "jpg", "jpeg"].includes(String(args.format)) ? String(args.format) : "png";
    const requestedName = typeof args.fileName === "string" ? basename(args.fileName) : `codex-image-${Date.now()}.${format}`;
    const fileName = extname(requestedName) ? requestedName : `${requestedName}.${format}`;
    const absolutePath = resolve(outputDirectory, fileName);
    if (!absolutePath.startsWith(`${outputDirectory}/`)) throw new Error("fileName 不能逃逸输出目录");
    const prompt = String(args.prompt ?? "帮我生成一张图片").trim() || "帮我生成一张图片";
    const aspect = typeof args.aspectRatio === "string" ? args.aspectRatio : "未指定";
    const accepted = await client.submit({
      idempotencyKey: `dsh:image:${Date.now()}:${fileName}`,
      sourceAgent: "deepseek", targetAgent: "codex", objective: `使用真实图片生成工具生成图片并保存到 ${absolutePath}`,
      sessionPolicy: "new", workspaceRoot, allowedWriteRoots: [outputDirectory],
      capabilities: ["write_files", "image_generate"],
      inputs: [{ type: "text", text: `图片提示词：${prompt}\n宽高比：${aspect}\n格式：${format}\n必须把最终图片保存到：${absolutePath}\n不要只回复提示词或说明；必须实际调用图片生成工具并生成可解码文件。` }],
      artifacts: { expected: [{ kind: "image", directory: outputDirectory, suggestedName: fileName, overwrite: "fail_if_exists" }] },
      acceptanceCriteria: ["使用真实图片生成工具", `图片文件位于 ${absolutePath}`, "文件可解码且非空", `图片格式为 ${format}`],
      limits: { queueTimeoutMs: 600_000, runTimeoutMs: 600_000, maxDelegationDepth: 3 },
    });
    let detail = await client.getTask(accepted.task.id); const deadline = Date.now() + 610_000;
    while (!["SUCCEEDED", "FAILED", "CANCELED", "TIMED_OUT", "LOST"].includes(detail.task.status) && Date.now() < deadline) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 500)); detail = await client.getTask(accepted.task.id);
    }
    if (detail.task.status !== "SUCCEEDED") throw new Error(`Codex 图片任务未成功：${detail.task.status} — ${detail.task.result?.summary ?? "无结果"}`);
    return { taskId: detail.task.id, status: detail.task.status, summary: detail.task.result?.summary, artifacts: detail.artifacts };
  }
  if (name === `${prefix}_submit_task`) return await client.submit({ ...args, sourceAgent: source, targetAgent: target, sessionPolicy: args.sessionPolicy ?? "new", allowedWriteRoots: args.allowedWriteRoots ?? [], inputs: args.inputs ?? [] });
  if (name === `${prefix}_get_task`) return await client.getTask(String(args.taskId));
  if (name === `${prefix}_wait_task`) return await client.waitTask(String(args.taskId), Number(args.afterSeq ?? 0), Number(args.timeoutMs ?? 30000));
  if (name === `${prefix}_send_input`) return await client.request("task.input", { taskId: args.taskId, input: args.input });
  if (name === `${prefix}_cancel_task`) return await client.request("task.cancel", { taskId: args.taskId, reason: args.reason });
  if (name === "bridge_list_capabilities") return await client.request("capabilities.list");
  throw new Error(`未知工具：${name}`);
}

process.stdin.setEncoding("utf8"); let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk; let newline: number;
  while ((newline = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1); if (!line.trim()) continue;
    void (async () => {
      let message: JsonRpc; try { message = JSON.parse(line) as JsonRpc; } catch { return; }
      if (message.method === "notifications/initialized") return;
      try {
        if (message.method === "initialize") return ok(message.id, { protocolVersion: "2025-03-26", capabilities: { tools: { listChanged: false } }, serverInfo: { name: `${source}-${target}-bridge`, version: "0.1.0" } });
        if (message.method === "tools/list") return ok(message.id, { tools });
        if (message.method === "tools/call") {
          const params = message.params ?? {}; const value = await callTool(String(params.name), (params.arguments ?? {}) as Record<string, unknown>);
          return ok(message.id, { content: [{ type: "text", text: JSON.stringify(value, null, 2) }], structuredContent: value });
        }
        if (message.id !== undefined) return respond({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } });
      } catch (error) { fail(message.id, error); }
    })();
  }
});
process.on("SIGTERM", () => { client.close(); process.exit(0); });
