<div align="center">

<h1>Swob</h1>

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

<p><strong>AI 会遗忘（compact），你不会。</strong></p>

<p>Claude Code、Codex 和 Cursor 的会话管理器 — 浏览、搜索、恢复、续写任意对话。</p>

<img src="e2e/screenshots/chat-loaded.png" alt="Swob 主界面" width="800" />

</div>

---

## 为什么需要 Swob

Claude Code 会通过 compact 压缩对话来节省上下文。一旦压缩，原始消息就消失了——你只能看到摘要。**Swob 保留一切。**

除了恢复功能，Swob 还是你 AI 编程工作流的完整控制中心：把数百个会话整理进文件夹、用类 Spotlight 的快捷键跳转到任意对话、追踪 token 消耗，甚至通过 SSH 在手机上续写会话。

---

## 功能

### 🔓 Compact 前原始对话恢复
展开任意 compact 区块，查看原始消息。目前唯一能做到这一点的工具。

### ⚡ Spotlight 会话跳转（⌘⇧K）
跨所有会话的模糊搜索，不到一秒跳转到任意对话。

### 📁 会话浏览与整理
树形侧边栏，支持嵌套文件夹、拖拽排序、自定义标题、分支检测。三种视图模式：精简 / 完整 / Markdown。

### 🔀 多工具支持
同时读取 **Claude Code**、**Codex** 和 **Cursor CLI** 的会话——一个界面管理全部。

### 📊 Token 洞察
365 天热力图、按模型的费用分解、项目排行榜、每日时间轴。清楚掌握 token 去向。

### ▶️ 一键续写
单击即可在 Terminal 或 iTerm2 中续写任意会话。支持批量续写整个文件夹。自动保留工作目录和 `--dangerously-skip-permissions` 模式。

### 🌐 SSH 远程续写
配置 SSH 连接，直接从应用中续写远程服务器上的会话。

### 💻 CLI（`swob`）
```bash
swob search "认证 bug"              # 搜索会话
swob list --source claude           # 按来源列出
swob resume <sessionId>             # 获取续写命令
swob insights                       # token 统计
swob active                         # 显示活跃会话
swob install                        # 安装 CLI + Skill
```

### 🔍 全文搜索
全局搜索（⌘K）跨所有会话，局部搜索（⌘F）支持正则。匹配内容自动展开 compact 折叠区块。

### 🖊️ 高亮与笔记
选中任意文本即可标注。所有高亮汇总在侧边栏，点击可跳回原位。

### ☁️ iCloud 同步
会话备份到 `~/Documents/Swob/`（iCloud 同步）。自动检测并按需下载 iCloud 占位符文件。

### 🌏 双语界面
完整支持中文（zh-CN）和英文。

---

## 截图

<table>
  <tr>
    <td align="center"><b>会话浏览器</b></td>
    <td align="center"><b>对话视图</b></td>
    <td align="center"><b>全局搜索</b></td>
  </tr>
  <tr>
    <td><img src="e2e/screenshots/sidebar-loaded.png" alt="会话浏览器" /></td>
    <td><img src="e2e/screenshots/chat-loaded.png" alt="对话视图" /></td>
    <td><img src="e2e/screenshots/search-opened.png" alt="全局搜索" /></td>
  </tr>
</table>

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

## 工作原理

Swob 读取 Claude Code、Codex 和 Cursor 存储在本地的 JSONL 对话日志。解析会话文件、检测跨文件续写和分支、重建 compact 前的历史记录，并以可视化界面呈现。你的数据始终在本地——Swob 不上传任何内容。

---

## 技术栈

| | |
|---|---|
| 框架 | Electron 40 + React 19 + TypeScript |
| 构建 | electron-vite |
| 状态管理 | Zustand |
| UI | Tailwind CSS 4 |
| 图表 | Recharts |
| 测试 | Vitest + Playwright |

---

## 许可证

[AGPL-3.0](LICENSE)
