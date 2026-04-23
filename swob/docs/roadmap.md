# Swob Roadmap

## 愿景

以 session 为核心的本地 AI 操作系统 — 长在 Claude Code 生态上，让人们瞥见 AI 操作系统的曙光。

## 定位（当前阶段）

**Claude Code 的可视化工作台** — 管理记忆、组织项目、延续对话。

用户今天下载 Swob 的理由：AI 会忘（compact），你不会。Swob 帮你找回丢失的上下文，组织跨项目的工作流，一键恢复任何对话。

## 阶段目标

1. **现在：** 把"浏览和管理历史 session"做到竞品无法比的好（修 bug、打磨体验）
2. **近期：** 笔记系统 + 内嵌终端，从"回顾工具"变成"工作台"
3. **中期：** 窗口管理 + 文件上下文，成为 Claude Code 的完整可视化壳
4. **远期：** 跨 AI 工具的 session 管理，真正的本地 AI 操作系统

## 竞争策略

**直接竞品：** claude-code-history-viewer、claude-code-viewer、claude-history-viewer (VS Code)。
它们都局限于 Claude Code 内部架构（project、JSONL），没有以用户为中心。

**Swob 的差异化：**
- Pre-compact 深度恢复 — 可视化 compact 前后差异，标记重要片段
- 持久化组织系统 — 文件夹是"工作流模板"，一键恢复整组会话
- 跨项目全景 — "上周我在所有项目上做了什么"
- 笔记系统 — 划线、金句收藏、跨 session 知识沉淀（竞品都没有）

**不竞争的领域：** 命令行补全（Fig/Amazon Q）、通用 workspace manager（Moom/Workspace+）。

---

## Current Status (v0.1)
- [x] Session 列表加载与展示
- [x] 文件夹/子文件夹树状组织 + 拖拽
- [x] Compact 分段折叠（pre-compact 内容可展开）
- [x] 多文件 session 合并（续写 vs 分支检测）
- [x] Sidechain 标记（rejected plan）
- [x] Resume 保留权限模式
- [x] 全文搜索
- [x] 分支 session 共享上下文
- [ ] Bug: 拖拽偶尔不生效
- [ ] Bug: 配置持久化偶发问题

---

## Priority Roadmap（基于调研结论）

### P0: 先修 bug，让现有功能可靠

**用户报告的 bug（2026-03-05）：**
1. 拖拽文件夹只能变成子文件夹，不能变成同级
2. 右侧边栏文件树太乱 — 去掉左侧图标、去掉"读取"标签，展示完整工作目录（像 IDE）
3. 重命名功能失效
4. 右键"添加到文件夹"菜单无法超出窗口边界
5. 分支检测不准确 — "你认识的你自己"应有 2 个分支但未识别
6. 启动太慢，每次点击都要加载
7. 搜索没有快捷键
8. 搜索结果不准确，无关键词高亮
9. 精简/完整模式没有实质区别，聊天展示需优化
10. 顶栏搜索框位置怪（偏左上角）；Resume 按钮放顶栏看起来像全局操作，实际是单 session 维度

**基础防御：**
- 防御性解析：未知 JSONL type 优雅降级而非崩溃
- 格式快照测试：存 fixture JSONL，每次回归

### P1: 内嵌终端 — 从回顾工具变成工作台
> 技术路径成熟：xterm.js + node-pty + Electron IPC。Hyper/Tabby/Wave 全用这套。

1. **内嵌终端** — xterm.js + node-pty，不再跳转 Terminal.app
2. **横向 Tab** — 多终端标签页，类浏览器切换
3. **文件夹批量 Resume** — 一键打开为标签页组
4. **主题配置** — xterm.js ITheme，预设几套 + 自定义

### P2: 笔记系统 — 核心差异化（依赖 P1 内嵌终端）
5. **划线笔记** — 选中文本 → 高亮 + 笔记，记录金句和关键洞察
   - 历史对话回顾时：在聊天记录中划线
   - 内嵌终端实时对话时：在终端输出中划线（依赖 P1）
   - 跨 session 笔记汇总视图
6. **置顶** — pin 关键消息到顶部
7. **更好的标题** — 自动从首条有意义消息生成标题 / 手动编辑
8. **通知系统** — session 完成后桌面通知（监听 JSONL 写入停止）
9. **compact 差异可视化** — 对比 compact 前后内容，高亮丢失的关键信息

### P3: 文件上下文
10. **文件树浏览** — session 关联的文件变更列表（已有 referencedFiles 数据）
11. **内嵌文件查看** — 点击路径直接查看（只读 Monaco/CodeMirror）
12. **文件树 → 终端拖拽** — 从侧边栏拖文件到终端对话中作为上下文

### P4: Workspace 管理
13. **Tab 组持久化** — 保存当前 tab 组，下次启动恢复
14. **Menu bar 模式** — 最小化到菜单栏，后台管理 session 进程
15. **窗口管理** — 独立窗口、应用内窗口、窗口组、Canvas 式可视化布局

### P5: 远期
16. 消息队列（排队多个 prompt）
17. Per-session 自定义指令（`--append-system-prompt`）
18. 全局 AI Agent "Swob"（以全部 session 为上下文）
19. Skill 系统 / 安装分发
20. 内嵌浏览器（Electron webview）
21. 手机端远程终端
22. **消息中心** — 多窗口多会话并行时的统一通知列表（完成、报错、需要输入等）
23. **Agent Team 支持** — Claude Code 多 agent 协作的可视化管理（任务分配、进度、agent 间通信）

### 不做
- 全自动自愈（风险极高）
- 命令行补全（Fig/Amazon Q 的领域）

---

## Research Conclusions

### xterm.js + Electron 内嵌终端
- **可行性：完全成熟**。Hyper/Tabby/Wave 全部验证过
- **工作量：2-3 天 MVP**，1-2 周产品级
- **架构：** Main (node-pty) ↔ IPC ↔ Renderer (xterm.js + WebGL addon)
- **坑点：** node-pty 是 native module，需要 @electron/rebuild
- **性能：** WebGL 渲染器比 Canvas 快 900%，5000 行 scrollback ≈ 34MB 内存
- **`claude --resume` 完全支持**：PTY 是真正的伪终端

### macOS Workspace Save/Restore
- **窗口位置/应用列表：可行**（AppleScript + System Events）
- **浏览器标签：可行**（Chrome/Safari/Arc 支持 AppleScript，Firefox 不行）
- **Terminal 会话：部分可行**（能拿到 cwd 和进程列表，不能恢复运行中程序状态）
- **Claude Code 恢复：优雅可行**（save session ID → `claude --resume <id>`）
- **结论：只做 Swob 自己的 tab 组恢复，不做通用 workspace manager**
- **权限：** 如果只管自己的终端 tab，不需要 Accessibility / Automation 权限

### 竞品格局
| 产品 | 定位 | 与 Swob 关系 |
|------|------|-------------|
| Warp | AI 终端替代品 | 不竞争。Swob 是终端的伴侣 |
| Wave Terminal | 开源 AI 终端 | 不竞争。Wave 的 AI 是内嵌聊天窗口模式 |
| Cursor | AI IDE | 不竞争。不同品类 |
| Tabby | SSH 管理终端 | 不竞争。不同场景 |
| Fig/Amazon Q | 命令行补全 | 不竞争。输入层增强 |
| **claude-code-history-viewer** | **桌面会话浏览器** | **直接竞品**。全文搜索 + token 统计 |
| **claude-code-viewer** | **Web 会话客户端** | **直接竞品**。可启动/恢复对话 |
| **claude-history-viewer** | **VS Code 插件** | **直接竞品**。侧边栏浏览 |

### 自运维软件
- **Claude Code JSONL 格式是未文档化的内部实现**，Anthropic 不承诺稳定性
- **已发生过的格式变化：** file-history-snapshot、queue-operation 等新 type
- **现在该做的：** 防御性解析（未知 type 警告不崩溃）+ JSONL fixture 测试
- **远期可考虑：** 格式变化检测 Skill（只通知，不自动改代码）
- **不做：** 全自动自愈（风险极高，收益不明）
