# Swob Ideas Parking Lot

> 想到就扔这里，不急着做。每两周回顾一次，90% 会自然淘汰。
> 已进入 roadmap 的条目用 ✅ 标记。

## 2026-03-05

### 全局 AI Agent "Swob" ✅ → roadmap P5
- 形态：像素小脸，名字叫 swob
- 功能：类 Notion AI，以全部 session 聊天记录为上下文
- 分析提问模式、总结周报月报
- 也可用来运维 Swob 应用本身
- 自动总结"当前聊到啥了"

### Per-session 自定义指令 ✅ → roadmap P5
- 给单个 session 指定 CLAUDE.md（通过 `--append-system-prompt` 实现）
- Resume 时自动拼接自定义指令

### 分发 / 安装 ✅ → roadmap P5
- 做一个 Claude Code Skill，用户对 Claude Code 说"帮我安装 swob"就自动安装
- Skill 同时教会 Claude Code 如何运维 Swob（自动更新、格式适配）
- slash command 集成

### 手机端 ✅ → roadmap P5
- 面向 vibecoder 的远程终端 APP（SSH 连接 Claude Code）
- 类 Terminus 但更简单，完全针对 Claude Code 优化

### 窗口管理系统 ✅ → roadmap P4
- 独立窗口：session/终端可以弹出为独立窗口
- 应用内窗口：也可以在主界面内嵌打开
- 窗口组：创建窗口组，批量管理相关窗口
- Canvas 式管理：可视化拖拽排列窗口布局（类似 Figma/Miro 的自由画布）

### 右侧边栏 / 文件树增强（部分 ✅）
- 加"网页"、"应用"分区（session 中打开的 URL、启动的应用）
- ~~Notes 备注栏~~ ✅ → roadmap P2 笔记系统
- ~~完整 working directory 目录浏览~~ ✅ → roadmap P0 bug #2
- ~~文件树 → 终端拖拽~~ ✅ → roadmap P3
- ~~文件列表按时间排序~~ ✅ → roadmap P0 bug #2

### 自运维 / 用户即 Builder

**核心洞察：** Swob 的用户就是 Claude Code 用户，所以天然拥有维护 Swob 的能力。不需要造复杂的自动化系统，只需要让 Claude Code 能高效地维护这个项目（文档 + 测试 + 约束）。

**v1 落地框架（软件工程基本功，无额外系统）：**
```
claude-session-manager/
├── CLAUDE.md          ← 维护合约（架构、修改指南、不变量约束）
├── UPSTREAM.md        ← 上游依赖声明（JSONL 格式规格）
├── tests/fixtures/    ← 各种格式的 JSONL 样本
├── tests/*.test.ts    ← 解析逻辑单元测试（验收标准）
└── skills/            ← 用户装的 skill，让 Claude Code 知道 Swob 的存在
```

**三层递进（v1 → v2 → v3）：**

1. **维护合约（v1）** — CLAUDE.md + UPSTREAM.md + fixture 测试。机器可读的维护规格：数据源 schema、不变量约束、验收标准。AI 按合约修、按合约验，不再盲猜。渐进式积累：每次 bug 修复沉淀为一条新的合约规则。

2. **上游感知（v1.x）** — 当 Claude Code 更新导致 JSONL 格式变化时，检测到差异 → 通知用户 → 用户让 Claude Code 按合约修复。暂不做自动修复，先做检测 + 通知。

3. **联邦制自愈网络（v2+）** — 去中心化自治 + 中心化情报共享：
   - **Bug 自愈：** 用户本地遇到 bug → Claude Code 按合约自动修复 → 匿名上报 bug 摘要（不含聊天内容）→ 母体聚合分析 → 推送修复补丁 → 所有用户自动更新
   - **功能共享：** 用户让 AI 加了新功能 → 上报的不是代码，是"需求包"（需求描述 + 验收标准 + 约束条件）→ 其他用户的 AI 拿到需求包，在自己的代码上重新实现
   - **核心原则：共享的是知识，不是代码。** 同样的需求，不同的代码库状态，AI 各自适配，没有代码冲突问题
   - 每个节点能独立运行、独立修复，但共享问题情报和功能灵感

**能自动修的 vs 不能自动修的：**
- 能自动修：上游格式变化导致的解析错误（边界清晰、模式固定）
- 不能自动修：逻辑 bug、UI 交互、性能问题（需要人定义预期行为）

**冲突解决：** 功能共享不共享代码 diff，而是共享 prompt + 合约。多个功能改同一块代码时，每个用户的 AI 独立实现、独立适配，避免传统 merge conflict。

### 主题系统
- 支持导入 VS Code 主题（.json 格式，映射到 xterm.js ITheme + 应用 UI）

### 展示优化
- 聊天记录美化：paste 文本聚合显示
- Markdown 渲染优化
- 一键导出完整 session 为 Markdown
- ~~更好的精简/完整模式区分~~ ✅ → roadmap P0 bug #9
