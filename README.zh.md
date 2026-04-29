<div align="center">

<img src="docs/banner.png" alt="Swob" width="100%" />

<p>
  <a href="README.md">English</a> | <a href="README.zh.md">中文</a> | <a href="README.ja.md">日本語</a> | <a href="CHANGELOG.md">更新日志</a>
</p>

<p>
  <img src="https://img.shields.io/badge/版本-1.1.1-blue" alt="版本" />
  <img src="https://img.shields.io/badge/平台-macOS-lightgrey" alt="平台" />
  <img src="https://img.shields.io/badge/基于-Electron-47848F" alt="基于 Electron" />
  <img src="https://img.shields.io/github/downloads/IvyYang1999/swob/total" alt="下载量" />
  <img src="https://img.shields.io/badge/许可证-AGPL--3.0-green" alt="许可证" />
</p>

<h3>浏览、搜索、恢复你的 Claude Code 会话</h3>

<p>
  <strong>Claude Code</strong>、<strong>Codex</strong> 和 <strong>Cursor</strong> 的会话管理器。<br/>
  恢复被 compact 的对话。跨数百个 session 搜索。一键续写。
</p>

</div>

<br/>

<p align="center">
  <img src="docs/screenshot.png" alt="Swob 主界面" width="800" />
</p>

---

## 问题

你用 Claude Code 从 `~` 目录 vibe-code 好几个月了。200 多个 session 堆在一起毫无组织。一半已经被 compact——原始对话消失了，只剩下摘要。内置的 `/resume` 只显示最近的 session。想找到那个你解决了棘手 bug 的对话？祝你好运。

## 方案

Swob 读取 Claude Code、Codex 和 Cursor 存在磁盘上的 JSONL 文件。解析每一个 session，检测分支和续写关系，**重建完整的 compact 前历史**，并以可搜索、可整理的界面呈现。

数据 100% 留在本地。Swob 不上传任何东西。

---

## 核心功能

### 恢复被 Compact 的对话

Claude Code 会压缩对话来节省上下文。原始消息仍然在 JSONL 文件里——Swob 找到它们，让你展开任何 compact 块来阅读丢失的内容。**没有其他工具能做到这一点。**

### Spotlight 会话跳转 — `⌘⇧K`

全局快捷键唤出类 Spotlight 搜索窗口。支持内容、项目名、文件夹、时间（`今天`、`昨天`、`本周`）模糊搜索，按来源（`claude`、`codex`、`cursor`）过滤。不到一秒跳转到任意 session，无需切换窗口。

### 全文搜索 — `⌘K`

跨所有 session 一次搜索。匹配内容自动展开 compact 折叠区块，即使内容被 compact 了也能找到。局部搜索（`⌘F`）支持正则。

### 三工具合一：Claude Code + Codex + Cursor

读取 `~/.claude/projects/`、`~/.codex/sessions/` 和 `~/.cursor/projects/`——在一个界面浏览和恢复三个工具的所有 session。

### Token 洞察仪表盘

- 5 个统计卡片：总 token、session 数、对话轮次、活跃天数、预估时间
- 365 天贡献热力图（像 GitHub，但是看你的 AI 使用量）
- 来源环形图（Claude Code vs Codex vs Cursor）
- 模型使用分布
- 项目 token 消耗排行
- 30 天日趋势图

### 一键续写

点击任意 session 即可在 Terminal 或 iTerm2 中恢复。支持批量续写整个文件夹。自动保留工作目录和 `--dangerously-skip-permissions` 模式。也支持 Codex（`codex resume`）和 Cursor（`cursor agent --resume`）。

### SSH 远程续写

配置 SSH 连接，直接从应用中续写远程服务器上的 session。

### CLI — `swob`

```bash
swob search "认证 bug"           # 模糊搜索 session
swob list --source codex        # 按来源过滤
swob resume <id>                # 获取续写命令
swob insights                   # token 使用统计
swob active                     # 显示运行中的 session
swob install                    # 安装 CLI + Agent Skill
```

所有命令输出 JSON。`swob install` 还会安装一个 Claude Code Skill，让 Claude 在对话中可以调用 `swob` 作为工具。

### 会话整理

树形侧边栏，嵌套文件夹、拖拽排序、自定义标题。三种视图：精简（隐藏工具噪音）、完整（全部展示）、Markdown（干净导出）。

### 分支检测

自动检测跨文件续写（multi-file continuations）和并发分支。侧链（被放弃的方案）以暗色标记。

### 高亮与笔记

选中任意文本标注为书签。所有高亮汇总在右侧边栏，支持点击跳回——跨 session 的个人知识足迹。

### 元数据侧边栏

每个 session 展示：创建/更新时间、对话轮次、token 用量（input/output/cache）、工具调用统计、skill 调用记录、文件操作树、引用文件列表、预估活跃时间。

### iCloud 备份

Session 自动备份到 `~/Documents/Swob/`，生成可读的 Markdown 转录。iCloud 占位符文件自动检测并按需下载。

### 活跃会话检测

绿点标记正在运行的 session。通过 `ps` 轮询（1s 间隔）和文件变化监听器检测。

### 拖拽导出

每个 session 自动导出为 Markdown。拖到其他应用（Finder、备忘录、另一个 Claude Code 对话）即可跨会话传递上下文。

### 双语界面

完整支持中文（zh-CN）和英文。

---

## 安装

从 [**Releases**](https://github.com/IvyYang1999/swob/releases) 下载最新的 `.dmg`。

或从源码构建：

```bash
git clone https://github.com/IvyYang1999/swob.git
cd swob
npm install
npm run dev          # 开发模式（热重载）
npm run build:mac    # 在 dist/ 生成 .dmg
```

**系统要求：** macOS（Apple Silicon 或 Intel）· 已安装 Claude Code

---

## 技术栈

Electron 40 · React 19 · TypeScript · Zustand · Tailwind CSS 4 · Recharts · electron-vite

---

## 相关项目

- [claude --resume](https://docs.anthropic.com/en/docs/claude-code) — 内置 session 恢复（仅限最近的 session）
- [CC Switch](https://github.com/farion1231/cc-switch) — AI CLI 工具的供应商和配置管理器
- [awesome-claude-code](https://github.com/hesreallyhim/awesome-claude-code) — Claude Code 工具合集

---

## 许可证

[AGPL-3.0](LICENSE)
