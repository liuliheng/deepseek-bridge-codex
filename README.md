# Local Agent Bridge

Codex 与 DeepSeek Harness 的本地双向任务桥。`labd` 通过 Unix domain socket 提供鉴权 IPC，以 SQLite（WAL）持久化任务、事件、审批、连接与产物；真实运行使用 Codex App Server 和官方 `dsh --profile headless`。

## 快速验证

```bash
npm test
npm start
# 另开终端
npm run labctl -- doctor
npm run labctl -- agents
```

当前机器已安装 Harness Web 路由和 `codex-bridge@personal`。只有当用户在当前请求中明确、肯定地指定执行者时才会委派：Harness 会调用 `codex_do_work` / `codex_generate_image`，Codex 会调用 `deepseek_do_work`。仅提及、讨论、引用、比较或否定另一方名称不会触发委派。启动、示例、已验收任务和故障处理见 [使用手册](docs/使用手册.md)。

## 目录

- `apps/labd`：守护进程、路由、IPC 和恢复
- `apps/labctl`：诊断与任务 CLI
- `packages/protocol`：协议、状态机和错误
- `packages/store`：SQLite event store
- `packages/policy`：路径、capability 和循环防护
- `packages/artifact-registry`：MIME、图片解码、大小与 SHA-256 验证
- `packages/adapters`：Codex App Server、DeepSeek Harness headless adapter，以及仅供自动化测试使用的测试 adapter
- `packages/sdk`：Unix socket 客户端
- `plugins`：Codex plugin、DeepSeek companion MCP
- `npm run generate:codex-schema`：需要排查 Codex App Server 协议时，按需生成当前 CLI 版本的 schema（生成目录不入库）
- `tests`：协议、安全、存储、路由、审批、IPC 集成测试

要求 Node.js 24+。项目运行时无第三方 npm 依赖。

## 并发配置

`labd` 对 **Codex 与 DeepSeek Harness 两个方向分别限流**（每个目标 agent 独立的并发上限），默认每个 agent 最多 **4** 个并发任务，超出部分按 `limits.queueTimeoutMs`（默认 60 秒）排队。提高或降低并发在项目根目录的 `lab.config.json`（可参考 `config/lab.example.json`）中配置：

```jsonc
{
  // 旧版数字：对 Codex 和 DeepSeek 两个 agent 同时生效（向后兼容）
  "maxConcurrentPerAgent": 4,
  // 新版按 agent 分别设置：未指定的 agent 使用全局默认值 4
  // "maxConcurrentPerAgent": { "codex": 2, "deepseek": 6 }
}
```

也可用环境变量覆盖（优先级：按 agent 环境变量 > 按 agent 配置 > 全局环境变量 > 全局配置 > 默认值 4）：

```bash
LAB_MAX_CONCURRENT_PER_AGENT=4      # 两个 agent 同时生效
LAB_MAX_CONCURRENT_CODEX=2          # 仅 DeepSeek → Codex 方向的并发
LAB_MAX_CONCURRENT_DEEPSEEK=6       # 仅 Codex → DeepSeek Harness 方向的并发
npm start
```

用 `npm run labctl -- agents` 可查看每个 agent 当前的 `maxConcurrent` 与 `active` 并发数。并发数只受 Bridge 自身限制；单个调用方会话能否同时发起多个委派，还取决于调用方（DeepSeek Harness / Codex）是否并行执行 MCP 工具调用——多个会话或多个并行工具调用可以充分利用提升后的并发。
