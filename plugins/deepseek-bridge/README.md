# DeepSeek Bridge companion

这是 DeepSeek Harness Web 的 Codex companion。当前机器已通过 `dsh-web.patch.yml` 持久安装；对话模型只看到 `codex_do_work` 与 `codex_generate_image` 两个直达工具。只要用户点名 Codex，Harness 就把完整任务交给新的 Codex App Server thread，而不是自己代办。

不设置 `LAB_MCP_DIRECT_ONLY=true` 时，MCP server 仍会暴露底层 submit/get/wait/input/cancel/capabilities 工具供开发诊断。反向入站任务使用官方 `dsh --profile headless` adapter。
