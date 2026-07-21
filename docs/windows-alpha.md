# Windows Native Alpha

Windows Native Alpha 只验证 Swob 的最小本地闭环：Claude Code 和 Codex 的会话浏览、搜索、备份、Resume 与本地 Library。它不是 macOS 版所有功能的对等移植。

## 本地构建

在 Windows x64、Node.js 22 上运行：

```powershell
npm ci
npm test
npm run build:win
```

成功后产物位于 `dist/swob-<version>-windows-x64.exe`。这是未签名的 NSIS 内部测试包，SmartScreen 警告属于预期现象。GitHub Actions 的 `Windows Native Alpha` 工作流执行同样的测试和打包，并保留安装包 14 天。

`build:win` 会关闭 electron-builder 的二次 node-gyp rebuild：当前 `better-sqlite3` 依赖已随 npm 包提供 `win32-x64.node` 预编译件，重编译反而会让 macOS 上的 Windows 交叉打包失败。CI 仍先执行 `npm ci` 和全量测试，打包后也会要求 `.exe` 实际存在。

## Alpha 边界

- 支持：Windows Native x64，Claude Code、Codex，Windows Terminal / PowerShell / cmd Resume。
- 不支持：Cursor、OpenCode、ZCode、CC-Mirror、Antigravity、Grok、Pi、Kimi、Hermes。
- 不在本阶段：WSL、OneDrive 占位文件、Windows CLI 安装、ARM64、自动更新、代码签名。
- 远程入口：SSH 和手机连接暂不在 Windows Native Alpha 开放，设置导航中不展示这两个入口。
- 不支持项在设置和首次启动页面显式告知；主进程也会失败关闭，不会尝试调用 macOS 命令。

## Windows 真机验收清单

1. 在标准用户账号下安装、启动、卸载，确认无需管理员权限。
2. 确认能发现 `%USERPROFILE%\.claude\projects` 与 `%USERPROFILE%\.codex\sessions`，盘符路径和含空格/中文项目可正常打开。
3. 分别用 Windows Terminal、PowerShell、cmd Resume Claude Code 和 Codex，检查单引号、空格和非 ASCII 路径。
4. 安装/卸载 Codex/ChatGPT Desktop 后分别测试 `codex://` 协议，确认未注册时给出可理解错误。
5. 在未开启开发者模式的机器上向 Library 文件夹添加会话，确认 junction 可用且无需提权。
6. 创建标题含 `CON`、`PRN`、结尾点/空格、emoji 和 Windows 保留字符的会话，确认 Library 同步不失败。
7. 用 macOS Library 副本启动 Windows 版，确认 POSIX 源路径显示为远端/不可用来源但页面不崩溃。
8. 验证 Cursor 等未支持来源不被扫描，UI 中可见 Alpha 边界；验证 WSL 和 OneDrive 占位文件不会被误当作已支持功能。
