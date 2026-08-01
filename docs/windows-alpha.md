# Windows Native Beta

> 路径为了兼容旧链接保留为 `windows-alpha.md`。从 v1.4.0 起，Swob 计划在 GitHub Releases 中提供 Windows x64 Beta；当前公开版 v1.3.1 仍只有 macOS 安装包。

Windows Native Beta 的目标是让 Windows 用户安全地完成一条有价值的本地闭环：安装、首次启动、发现 Claude Code / Codex 会话、阅读、检索、查看 Insights 和设置。它不是 macOS 版的功能对等移植。

## 下载与安装

- 从 [GitHub Releases](https://github.com/IvyYang1999/swob/releases) 下载 `swob-<version>-windows-beta-x64.exe`。不要从第三方镜像获取安装包。
- Beta 只支持 64 位 Windows；ARM64 和 32 位 Windows 不在本阶段。
- 安装包目前未经代码签名，不支持 Windows 自动更新。正式发布页会明确标注这两个边界。

### SmartScreen 提示怎么处理

Windows 可能对尚未建立信誉的未签名 Beta 弹出“Windows 已保护你的电脑”。只在以下信息都匹配时继续：

1. 下载页是 `github.com/IvyYang1999/swob/releases`。
2. 文件名符合 `swob-<version>-windows-beta-x64.exe`，版本与 Release 页一致。
3. Release 页公布的 SHA-256 与本地结果一致：

   ```powershell
   Get-FileHash .\swob-<version>-windows-beta-x64.exe -Algorithm SHA256
   ```

4. 在 SmartScreen 界面点击“更多信息”，确认应用名为 Swob、发行者显示“未知发行者”，然后点击“仍要运行”。

如果来源、文件名、摘要或发行者与 Release 说明不一致，立即停止安装并报告。以上是安装指南，不是 SmartScreen 安全性的替代品。

> **截图证据状态（2026-08-02）：待补。** SmartScreen 界面受 Windows 11、Mark-of-the-Web 和 Microsoft 信誉系统影响，必须在真实 Windows 11 桌面上从浏览器下载当次 Release 资产后采集“初始拦截”、“更多信息”和“仍要运行”三张图。CI 静默安装不能替代这项验收，本文档不伪造示意图。

## 已声明的 Beta 边界

| 能力 | Beta 状态 | 说明 |
|---|---|---|
| NSIS x64 安装 | 支持 | 当前未签名；不宣称 SmartScreen 无警告 |
| Claude Code / Codex 发现、阅读、检索 | 支持 | 只扫描 Windows 原生 `%USERPROFILE%` 路径，不扫描 WSL |
| Insights 与设置 | 支持 | AI Insights 仍需用户主动配置与确认 |
| Claude Code 终端 Resume | 部分验证 | Windows Terminal / PowerShell / cmd 命令生成和引号单测已过；真实已安装 `claude` 启动及会话锚点待 Windows 11 复核 |
| Claude Desktop Resume | 不支持 | Windows Beta 主进程主动拒绝 `claude-desktop` surface，不将 macOS 导入能力带到 Windows |
| Codex 终端 Resume | 部分验证 | Windows Terminal / PowerShell / cmd 命令生成和引号单测已过；真实已安装 `codex` 启动及会话锚点待 Windows 11 复核 |
| Codex Desktop Resume | 部分验证 | `codex://threads/<session-id>` 生成和 Windows 表面允许规则有单测；已安装/未安装 Codex Desktop 与启动后会话锚点待真机复核 |
| Claude/Codex 源目录 watcher | 部分验证 | chokidar 非 macOS 后端、路径匹配、丢事件恢复有单测；打包后 Windows 运行中新建/追加真实会话的实时 UI 更新未验收 |
| Library | Beta | 支持本地 NTFS 路径；junction 、中文/空格和保留名需真机复核 |
| 其他 harness | 不支持 | Cursor、OpenCode、ZCode、CC-Mirror、Antigravity、Grok、Pi、Kimi、Hermes 在 Windows Beta 不扫描 |
| WSL / OneDrive 占位文件 | 不支持 | 不将两者暗示为可用 |
| Windows CLI / Agent Skill 自动安装 | 不支持 | macOS 的自动安装承诺不适用于 Windows Beta |
| SSH / 手机连接 | 不支持 | Windows 设置中隐藏这些入口 |
| ARM64 / 自动更新 / 代码签名 | 不支持 | 签名完成前不修改此声明 |

## 开发和 CI

在 Windows x64、Node.js 22 上运行：

```powershell
npm ci
npm test
npm run build:win
```

`build:win` 会构建 NSIS x64 安装包，然后执行 `check:package`。该门禁会拆解实际 Windows 产物，检查 `app.asar`、运行时文件白名单和第三方 Notices；只有“生成了 `.exe`”不算通过。

`Windows Native Beta` CI 还会在 GitHub 托管的 Windows runner 上做静默安装、PE x64/原生模块检查，并启动安装后的应用完成一条六截图路径：

1. `01-onboarding.png`
2. `02-discovery.png`
3. `03-reading.png`
4. `04-search.png`
5. `05-insights.png`
6. `06-settings.png`

这些自动化证据使用隔离的 Claude/Codex fixture，证明打包后主路径没有断裂；它们不证明用户真实数据、真实 CLI Resume、SmartScreen 或 Windows 11 桌面体验。GitHub 托管 runner 也不是本任务要求的 Windows 11 真机/虚拟机验收。

## Windows 11 发布前人工验收

使用当次 Release 的未签名 `.exe`，在一台标准用户、未开启开发者模式的 Windows 11 x64 环境上执行：

1. 从浏览器下载，记录 SHA-256，采集 SmartScreen 三张图，完成安装和首次启动。
2. 完成 onboarding，确认 Beta 边界可见，截图。
3. 准备至少一个真实 Claude Code 和 Codex 会话，确认自动发现，截图。
4. 打开两种来源的详情，检查中文、emoji、空格路径和工具消息，截图。
5. 用仅出现在消息正文的唯一词检索，确认命中正确会话，截图。
6. 打开 Insights，核对会话数与 token 有来源的统计，截图。
7. 打开设置，确认只出现 Windows Terminal / PowerShell / cmd，不出现 iTerm，且不宣称 CLI、更新或签名可用，截图。
8. 分别实测 Claude Code/Codex Resume；安装与卸载 Codex Desktop 后检查 `codex://` 已注册/未注册的结果。
9. 在 NTFS Library 中测试 junction，以及盘符、中文、空格、emoji、`CON` / `PRN` / 末尾点或空格等边界。
10. 卸载应用，确认用户 Library 不被误删。

验收证据不应含真实用户隐私；如果使用真实会话，发布前必须脱敏。
