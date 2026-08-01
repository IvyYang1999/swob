# Swob 项目事实

Swob 是 local-first 的 AI 编码会话桌面工作台，基于 Electron、React、TypeScript、Zustand、Tailwind CSS 与 electron-vite。它统一发现、浏览、搜索、分析和恢复多种 Agent harness 的本地会话；产品版本以根目录 `package.json` 为准。

## 当前数据源

- 原生运行时：Claude Code、Codex、Cursor、OpenCode、ZCode、Pi。
- 兼容运行时：CC-Mirror。
- 仅发现/识别：Antigravity、Grok/Factory、Kimi、Hermes。

能力等级的代码真相源是 `src/shared/provider-capabilities.ts`，新增或升级数据源时必须同步其契约测试与公开文案检查。

## 当前能力

- 本地会话发现、列表与文件夹管理，紧凑/完整/Markdown 阅读视图。
- 全局与会话内搜索、compact 前内容恢复、续写/分支谱系和执行树。
- 上下文压力、用量、健康审计与 Insights 报告。
- 高亮、图像索引、输出、token insights、Galaxy、审计和分享模板等 lenses。
- Terminal/iTerm2 resume、Markdown 上下文导出、分享与 CLI。

## 架构边界

- `src/main/`：Electron 主进程、会话发现/解析、canonical store、provider runtime、搜索、Library 与报告任务。
- `src/preload/`：主进程与 renderer 的类型化 IPC 边界。
- `src/renderer/`：React UI、Zustand 状态、会话阅读与 Insights。
- `src/shared/`：跨进程协议、provider 能力与 i18n 等共享契约。
- `e2e/`：Playwright 端到端验收；`testdata/`：脱敏夹具；`scripts/`：构建、合规和只读流程工具。
- 用户 Library 位于 `~/Library/Application Support/Swob/`；会话源仍归各 harness 所有，Swob 不改写其 transcript/JSONL。

## 研发真相源

- 协作、验证、合并和发布规则：根目录 `AGENTS.md`。
- 并行工作与认领：`docs/PARALLEL.md`。
- UI 设计：`docs/DESIGN.md`。
- 脚本与门禁：`package.json` 的 `scripts`；不要依据旧文档猜测命令。
