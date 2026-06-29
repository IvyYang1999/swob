# Swob Mobile 设计文档

> 创建日期：2026-04-25

## 产品定位

Swob 的移动端延伸。用户在手机上随时浏览所有 Claude Code 聊天记录（离线可用），需要实时操作时通过 SSH 连接电脑终端。

## 核心原则

- **离线优先**：Session 浏览不依赖电脑在线
- **桌面端零改动**：复用现有 Library 文件结构 + SSH 基础设施
- **AI Coding 专属优化**：不只是 SSH 客户端，是 Claude Code 的移动伴侣

## 整体架构

```
┌─────────────────────────────────────────┐
│          Swob Mobile (React Native)      │
│                                          │
│  ┌──────────┐  ┌──────────┐  ┌────────┐ │
│  │ Session   │  │  Chat    │  │ SSH    │ │
│  │ Browser   │  │  Viewer  │  │ Terminal│ │
│  │ (离线)    │  │ (离线)   │  │ (在线)  │ │
│  └─────┬────┘  └─────┬────┘  └───┬────┘ │
│        │              │           │       │
│  ┌─────▼──────────────▼─────┐  ┌──▼───┐ │
│  │   iCloud Drive Reader    │  │ SSH  │ │
│  │   (读 Swob Library 目录) │  │ Lib  │ │
│  └──────────────────────────┘  └──────┘ │
└─────────────────────────────────────────┘
        │                            │
   iCloud Drive                   SSH
   (自动同步)                  (直连电脑)
        │                            │
   ~/Documents/Swob/            user@mac
   (桌面端 Library 目录)
```

## 数据层 — iCloud Library 读取

Swob Library 的文件结构：

```
~/Documents/Swob/                    ← iCloud 同步目录
├── .swob-config.json                ← 全局配置
├── Swob 项目/                       ← 用户文件夹
│   ├── 修复登录 bug/
│   │   ├── .swob-session.json       ← session 元数据
│   │   ├── transcript.md            ← 聊天记录 Markdown
│   │   └── backup.jsonl             ← 原始 JSONL
│   └── 新增搜索功能/
│       └── ...
└── 另一个项目/
    └── ...
```

移动端的数据读取策略：

| 场景 | 读什么 | 说明 |
|------|--------|------|
| Session 列表 | `.swob-session.json` | 仅元数据，体积小，秒加载 |
| 聊天记录 | `transcript.md` | 已生成好的 Markdown，直接渲染 |
| 搜索/完整数据 | `backup.jsonl` | 需要完整消息时才读，按需加载 |

iCloud 处理：
- iOS 端用 `FileManager.default.ubiquitousIdentityToken` 检测 iCloud 可用性
- 通过 `NSMetadataQuery` 监听文件下载状态
- 首次打开某个 session 时，若文件未下载，触发 `FileManager.startDownloadingUbiquitousItem`
- 和桌面端已有的 `isICloudPlaceholder` / `triggerICloudDownload` 逻辑对称

不新建共享包：移动端直接读文件，复用同样的 JSON 结构。`.swob-session.json` 的类型定义直接抄到 RN 项目里，保持字段一致。

## SSH 终端

### 连接管理

- 保存多个 SSH 连接配置（host、user、port、密钥/密码）
- 支持从 session 的 `projectPath` 自动推断远程用户和目录（复用 `claudeProjectPathToCwd` 逻辑）
- 密钥存在 iOS Keychain / Android Keystore

### 终端交互

用户选中一个 session → 点「Resume」→ 自动拼接 SSH 命令：

```
ssh -t user@host "cd /Users/yytyyf/projects/xxx && claude --resume sessionId"
```

和桌面端 `buildSshResumeCommand` 逻辑完全一致。也可以打开自由终端手动操作。

### 终端组件

- WebView 内嵌 xterm.js（RN 没有成熟的原生终端库，xterm.js 生态最完善）
- SSH 通道用原生模块桥接（iOS 用 NMSSH / libssh2，Android 用 JSch）
- 数据流：`xterm.js ↔ WebView bridge ↔ Native SSH client ↔ SSH server`

### 手机端交互设计

基础层（对标 Termius）：

| 功能 | 方案 |
|------|------|
| 扩展键盘条 | `Ctrl` `Esc` `Tab` `↑` `↓` `←` `→` 固定一排，横划查看更多 |
| 常用组合键 | `Ctrl+C`（中断）`Ctrl+Z`（挂起）`Ctrl+D`（EOF）各一个按钮 |
| 字体缩放 | 双指捏合调整 |
| 历史滚动 | 两指上滑，单指下滑收键盘 |
| URL 识别 | 终端输出扫描 URL 正则，自动加下划线可点击，点击跳 Safari |
| 长按粘贴 | 系统剪贴板 |

AI Coding 专属层：

| 功能 | 交互 |
|------|------|
| Slash 命令面板 | 键盘条右侧一个 `/` 按钮，点开弹出常用 slash command 列表（`/clear` `/compact` `/help` `/review` 等），点选自动输入 |
| 常用指令 Snippets | 用户自定义常用命令，一键发送 |
| Resume 直达 | 从 session 列表点「Resume」，自动 SSH + 拼好命令直接执行 |
| yes/no 快捷按钮 | 检测到终端输出包含 `y/n` `yes/no` `[Y/n]` 时，在键盘条上方弹出大按钮，一键回复 |
| URL 跳转 | 识别 `http://` `https://` `localhost:PORT`，点击跳浏览器 |
| 输入历史 | 上箭头键快捷访问最近输入的命令 |

屏幕空间优化：
- 全屏终端模式：顶部导航条可下滑隐藏，获得最大终端空间
- 输入时自动收起 session 信息，聚焦终端
- 横屏时关闭侧边栏，终端宽度最大化

## 页面结构

底部 Tab 导航，三个 Tab：

### Tab 1: Sessions（离线可用）

- 数据来自 iCloud Library，不需要电脑在线
- 文件夹层级用 iOS 原生缩进展开/折叠
- 点击 session → 进入聊天记录页面
- 左滑 session → 快捷操作：Resume（需 SSH）、复制路径、删除
- 顶部搜索栏，支持全文搜索

子页面 Chat Viewer：
- 渲染 `transcript.md`
- 下拉加载更多（长对话分段加载）
- 搜索按钮可全文搜索
- 顶部显示 session 标题和 Resume 按钮

### Tab 2: Terminal（需 SSH 连接）

- 首次进入提示配置 SSH 连接
- 可同时开多个终端 tab
- 从 Sessions 页点 Resume 自动跳到这里并执行命令
- 扩展键盘条 + AI Coding 快捷操作

### Tab 3: Settings

- SSH 连接管理（增删改，密钥导入）
- Library 路径（默认 iCloud Drive 下自动发现）
- 外观（字号、主题）
- Slash 命令自定义
- Snippets 管理
- 关于 / 反馈

## 技术栈

| 领域 | 选择 | 理由 |
|------|------|------|
| 框架 | React Native + Expo（bare workflow） | Expo 加速开发，bare 方便加原生 SSH 模块 |
| 导航 | React Navigation 6 | 底部 Tab + Stack 导航 |
| 状态管理 | Zustand | 和桌面端一致 |
| 终端渲染 | WebView + xterm.js | RN 没有成熟终端组件 |
| SSH 连接 | iOS: NMSSH / Android: JSch | 原生 SSH 库，Native Module 桥接 |
| Markdown 渲染 | react-native-markdown-display | 渲染 transcript.md |
| iCloud 访问 | 原生 FileManager + iCloud container | 直接读 Library 目录 |
| 安全存储 | iOS Keychain / Android Keystore | 存 SSH 密钥和密码 |
| 语言 | TypeScript | 和桌面端一致 |

## 项目结构

独立新仓库（不在 Swob 桌面端仓库内）：

```
swob-mobile/
├── app/
│   ├── tabs/
│   │   ├── SessionsTab.tsx
│   │   ├── TerminalTab.tsx
│   │   └── SettingsTab.tsx
│   ├── screens/
│   │   ├── ChatViewerScreen.tsx
│   │   ├── SshConfigScreen.tsx
│   │   └── SnippetEditScreen.tsx
│   └── components/
│       ├── SessionCard.tsx
│       ├── FolderItem.tsx
│       ├── TerminalView.tsx
│       ├── ExtendedKeyboard.tsx
│       ├── SlashCommandPanel.tsx
│       └── UrlDetector.tsx
├── native/
│   ├── ios/
│   │   └── SshBridge.swift
│   └── android/
│       └── SshBridge.kt
├── lib/
│   ├── icloud.ts
│   ├── session-parser.ts
│   ├── ssh-manager.ts
│   └── types.ts
├── store/
│   ├── sessions.ts
│   ├── terminal.ts
│   └── settings.ts
└── assets/
    └── xterm/
```

## 实施阶段

### Phase 1：离线 Session 浏览器

- iCloud Library 读取
- Session 列表 + 文件夹展开
- Chat Viewer（渲染 transcript.md）
- 搜索
- 交付时即可用：手机上随时看所有聊天记录

### Phase 2：SSH 终端

- SSH 连接管理
- 终端组件（WebView + xterm.js）
- 扩展键盘条（Ctrl/Esc/Tab/箭头）
- Resume 一键直达
- URL 识别跳转
- 交付后：手机上既能看记录，又能实时操作终端

### Phase 3：AI Coding 优化

- Slash 命令面板
- 自定义 Snippets
- yes/no 快捷按钮
- 输入历史
- 横屏优化
- 交付后：手机上操作 Claude Code 的体验接近电脑

## 和桌面端的关系

- 独立仓库，独立发布
- 共享数据格式（`.swob-session.json`、`.swob-config.json`、`transcript.md`）
- 不共享代码，类型定义手动对齐（字段少且稳定）
- 桌面端零改动
