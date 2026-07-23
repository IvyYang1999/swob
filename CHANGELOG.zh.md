# 更新日志

[English](CHANGELOG.md)

## v1.3.0 — 2026-07-23

> **需要手动升级：** v1.2.0 及更早版本无法通过自动更新跨越旧的 ad-hoc/未签名信任边界。请下载对应架构的 v1.3.0 DMG 并覆盖安装一次；v1.3.0 不发布更新 metadata。

### 新功能

- **Session Galaxy 与会话血统导航**：把大型会话库呈现为稳定、可筛选的图谱；可在会话界面内继续查看关联会话树、执行树与 Context Pressure。
- **分层的 Provider 能力**：解析 6 种原生格式与 1 种 Claude 兼容格式；另检测 4 个实验来源，但在拿不到消息正文时不宣称支持 transcript、检索或审计。
- **Session Audit 与 AI Insights**：新增有证据的质量诊断、统一且有边界的分析范围、逐请求 Token 归因与价值换算；任何可选 LLM 请求都必须先得到明确隐私确认。
- **Agent 工作流**：新增真实打包链路的 CLI 契约、多 LLM Profile、智能重命名、应用内 Agent 面板、分享图导出，以及 Command/View/Widget 注册表。
- **Library 与引导工具**：新增来源感知引导、容量预估、Vault 迁移、镜头、可撤销整理、重复包恢复计划与更清晰的来源健康状态。

### 修复

- 通过单写者租约、generation 校验和恢复安全状态迁移，让 Library 写入在不确定时可靠地 fail closed。
- 修复 source watcher、Keychain、打包 CLI 原生依赖、SSH/云 Resume 路由、会话导航与 provider 身份稳定性。
- 关闭安全与合规审计发现的路径越界、私密 fixture、凭据脱敏、provider 协议、包体边界和发布签名缺口。
- 统一用户可见文案、语言门禁、导航入口、Insights coverage 时间语义与 Galaxy 布局稳定性。

### 架构

- 搜索迁移到 SQLite FTS5；通过虚拟列表限制 renderer 工作量，合并 watcher，并把图谱布局放入独立 worker。
- 冻结统一 provider 协议与能力真相层，并用强类型注册表承载展示和扩展点。
- 新增 fail-closed 发布门禁，覆盖 Developer ID 签名、公证、staple、包体内容、更新 metadata 与签名更新信任根。
- Swob 从 v1.3.0 起改为 Apache-2.0；v1.2.0 及更早版本仍为 AGPL-3.0-only。
