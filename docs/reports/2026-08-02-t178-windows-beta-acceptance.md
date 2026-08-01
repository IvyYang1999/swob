# T178 Windows Beta 打包与验收报告

**日期：** 2026-08-02

**工作分支：** `feat/t178-windows-beta`

**发布目标：** v1.4.0 起的 Windows x64 Beta

## 结论

T178 将 Windows 从“能交叉打包的 Alpha”推进到“具有独立产物合同、打包白名单门禁和打包后六步 UI 证据的 Beta 候选”。这不等于已完成对外发布：Windows 11 真实桌面、SmartScreen、真实 Claude/Codex 数据与 Resume 仍需一次发布前人工验收；Artifact Signing 申请也必须由 Dark Constant LLC 授权代表发起。

## 本次已落地

1. `npm run build:win` 固定生成 NSIS x64 Beta，资产名为 `swob-<version>-windows-beta-x64.exe`，并在打包后强制执行 `check:package`。
2. Windows CI 会拆解实际产物检查 app.asar 运行时白名单与 Notices，静默安装后检查 PE x64 与 SQLite 原生模块。
3. 打包后 E2E 从空的生产用户目录起步，不预置“onboarding 已完成”，覆盖 onboarding、Claude/Codex 发现、阅读、FTS 正文检索、Insights 和 Windows 设置六张截图。
4. fixture 中同时放入未支持的 ZCode 会话，用于反向验证 Windows Beta 没有误扫其他 harness。
5. Release 资产合同从 v1.4.0 起精确要求一个 Windows Beta x64 `.exe`，并让 macOS 发布 job 等待 Windows Beta 门禁通过后才发布。
6. 用户界面和文档由 Alpha 改为 Beta，且明示未签名、无 Windows 自动更新、无 Windows CLI/Skill 自动安装、无 WSL/OneDrive/ARM64，只支持 Claude Code 与 Codex。
7. 已形成 Dark Constant LLC 的 Artifact Signing 申请材料、RBAC、CI 接入与签名验收清单，见 [`docs/windows-signing-preparation.md`](../windows-signing-preparation.md)。

按“代码存在 ≠ Windows 已实测”的口径，Resume 和 watcher 另行分级：Claude/Codex 终端 Resume 已验证 Windows 命令生成与引号，未验证真实 CLI 启动后锚点；Codex Desktop 已验证 deep link 生成，未验证已安装客户端；Claude Desktop 在 Windows Beta 主动拒绝；Claude/Codex watcher 已有实现与单测，但打包后 Windows 中的实时文件变更尚未验收。详细能力矩阵见 [`docs/windows-alpha.md`](../windows-alpha.md)。

## 验收证据矩阵

| 门禁 | 可证明 | 不能证明 | 本次状态 |
|---|---|---|---|
| macOS 交叉构建 `build:win` | NSIS x64 能生成；实际 Windows app.asar 通过白名单 | Windows 上能启动/安装 | **通过**；10109 个 app.asar 路径通过门禁 |
| Windows 托管 runner | 安装、PE/原生模块、打包后 UI 主路径 | Windows 11 真实桌面、SmartScreen、真实用户数据 | 待分支推送后 CI |
| Windows 11 真机/虚拟机 | SmartScreen、真实客户端、Resume、Library/路径边界 | 长期稳定性与所有机型 | 待补；当前无 Windows 环境 |
| Artifact Signing | 发行者身份、签名链和时间戳 | 立即消除所有 SmartScreen 信誉提示 | 材料清单已就绪，申请待负责人 |

## 发布判定

### 本机可复现结果

- `npm test`：147 个测试文件通过，4 个按平台跳过；1170 项测试通过，12 项跳过。
- `npm run build:win`：通过，生成 113,571,021 字节的 `swob-1.3.1-windows-beta-x64.exe`。这是开发分支验证包，不是对外 v1.4.0 资产。
- 产物 SHA-256：`531438c5f1bcfd634bf188720c93aeb500376e946daf492f4082cf1b1906cb7b`。该值只绑定本次本地构建；正式 Release 必须重新计算并公布。
- PE 检查：内层 `Swob.exe` 为 PE32+ x86-64；安装包和内层 executable 的 Authenticode certificate table 均为 0，确认本 Beta 包未签名。electron-builder 日志中的 `signing with signtool.exe` 不能作为已签名证据。
- 首次交叉打包暴露了 Windows 产物中 electron-builder NSIS 的固定 `elevate.exe` helper 未在 outer allowlist 中。已将它作为**精确文件名**放行，并增加反例测试：`unexpected.exe` 仍必须被拒绝。修正后重跑整条 `build:win` 成功。
- 官网 `npm run check && npm run build`：通过；另在 Chrome 中回看 1440×900 与 390×844，打开/关闭移动菜单，检查页首和页尾 Windows Beta 按钮，两个尺寸的 `scrollWidth` 均等于 `clientWidth`，无横向溢出。

在以下四个条件同时满足前，不建议创建 v1.4.0 标签：

- 本地单测、类型检查、Windows 交叉打包和 `check:package` 全部通过。
- 分支推送后 `Windows Native Beta` 工作流绿灯，六张 fixture 截图经人工查看无异常。
- Windows 11 人工验收表已完成，上传六张核心路径图和三张 SmartScreen 图，且不含隐私数据。
- 给 Release notes 和官网的文案仍使用“Windows x64 Beta（未签名）”，不承诺 macOS 对等、Windows 自动更新或自动安装 CLI/Skill。

## 剩余风险

1. **没有 Windows 11 环境是当前唯一不可在本 Mac 上消除的验收缺口。** GitHub runner 可以消除大部分打包回归，但不是 Windows 11 用户环境。
2. 未签名 Beta 的 SmartScreen 结果受下载方式、Mark-of-the-Web 和 Microsoft 信誉影响；必须从真实浏览器下载 Release 资产验证。
3. 即使 Artifact Signing 完成，SmartScreen 信誉也不应被文案承诺为“首版立即无提示”。

## 负责人需要做的三件事

1. 安排一台 Windows 11 x64 真机或桌面虚拟机，按 [`docs/windows-alpha.md`](../windows-alpha.md) 执行人工验收。
2. 按 [`docs/windows-signing-preparation.md`](../windows-signing-preparation.md) 由 Dark Constant LLC 授权代表发起 Artifact Signing Public Trust 申请。
3. 在 CI 和 Windows 11 证据都就绪后，审批 v1.4.0 发布；本任务不会自行推送、打 tag 或发布。
