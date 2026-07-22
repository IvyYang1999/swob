# t120 发布信任根迁移与 Release 门禁完工报告

日期：2026-07-22  
分支：`feat/t120-release-gates`  
提交：`93e0063`、`0b18a6d`  
成功空跑：[GitHub Actions run 29899392544](https://github.com/IvyYang1999/swob/actions/runs/29899392544)

## 结论

t120 的代码与零副作用验收已完成。首个正式签名版仍被定义为手动信任根迁移版 `v1.3.0`；本任务没有修改当前 `1.2.0` 版本号，没有创建 tag、GitHub Release、release asset 或 workflow artifact，也没有运行真实发布。

自动更新仍不能对外宣布可用。代码现在保证：普通 tag 发布只产生经过签名验收的手动安装资产；只有专用 canary Mac 完成上一签名版到候选版的真实检查、下载、Squirrel 安装和重启验证后，才允许上传 `swob-signed-mac.yml`。

## 已落地的不变量

### 信任根与通道

- packaged app 固定使用 `swob-signed`，默认 `latest` 通道永久退役；
- `publishAutoUpdate: false`，tag workflow 无权自动上传 metadata；
- `v1.3.0` 被 promotion workflow 明确拒绝，必须手动覆盖安装；
- 官网、README 与更新文档同时解释 v1.2.0 用户的一次性手动迁移路径。

### Release fail-closed

- tag、`package.json`、`package-lock.json` 与 lock 根版本必须完全一致；
- 正式发布只接受稳定 `X.Y.Z`，且不得低于 `1.3.0`；
- Apple ID、专用密码与 Team ID 只从 Actions Secrets 注入；预检同时验证凭据可用和 Team ID 匹配固定信任根；
- 构建前必须是无 `node_modules` 的干净 checkout，`npm ci` 后必须是真实目录而非 symlink，并确认 `readdirp` 被锁定安装；
- electron-builder 使用 `--publish never`；上传前验证 Developer ID、Team ID、hardened runtime、Bundle ID、版本、架构、packaged channel、Gatekeeper、stapled ticket、DMG、ZIP、blockmap 与 metadata hash；
- Release 先保持 draft；六个不可变资产上传后，再从 GitHub 读取名称、大小和 SHA-256 digest 与本地产物逐一比对；全部通过才转为正式 Release，失败只清理 draft；
- 不生成或上传 `latest-mac.yml`，不在普通发布中上传 `swob-signed-mac.yml`，并保留两个 ZIP blockmap。

### 真实更新 E2E 与 metadata promotion

- `swob-canary` 被硬编码为唯一 E2E channel，环境变量不能改成任意 feed；
- base app 必须通过同一 Team ID、Bundle ID、稳定 channel、Gatekeeper 与 stapling 验证；
- target 必须严格高于已安装版本，feed 提供的版本必须与指定 target 完全一致；
- E2E 状态跨重启保存在 app userData；只有重启后 `app.getVersion()` 等于 target 才写入 passed；
- 任一步错误、进程提前退出、状态过期、版本不符或签名复验失败都会失败；
- canary metadata 在退出 trap 中清理；stable metadata 只有 E2E 通过后才上传，上传或后验失败时也会被清理；
- promotion 前后都断言 Release 精确资产清单，最终 stable metadata 的远端 digest 也必须匹配本地验证文件。

### 用户可见失败

- 后台启动检查失败仍保持安静，不影响主应用；
- 用户主动检查会明确显示“已是最新版”或可手动下载的失败提示；
- 下载失败可以重试；
- 安装／安全校验失败明确说明新版未安装并提供官方 Release 页；
- Renderer 只接收 `check | download | install` 类别，不接收可能包含路径或请求数据的原始 updater error。

## 验收证据

### GitHub Actions 空跑

成功 run `29899392544` 对提交 `0b18a6d02c25b1738f8a83e60196f81c630d2aa4` 执行：

- clean `npm ci`、非 symlink `node_modules`、`readdirp@5.0.0`：通过；
- 正确版本通过、伪造 tag 不一致被拒绝：通过；
- 缺 Apple 凭据被预检拒绝：通过；
- 全量逻辑测试与 production compile：通过；
- clean macOS Runner 生成 ad-hoc／unsigned 目录 fixture：通过；
- Developer ID 签名门禁拒绝该 fixture：通过；
- credentialed signing smoke job：按 `release-gates` 模式跳过；
- workflow artifacts：`0`。

第一次 run [`29899139344`](https://github.com/IvyYang1999/swob/actions/runs/29899139344) 在 clean UTC Runner 暴露了既有 `vault-lens` 日期测试依赖 `+08:00` 的问题。`0b18a6d` 将 fixture 改为按运行机器本地日历构造，并分别在 `UTC` 与 `Asia/Shanghai` 下通过后，第二次空跑全绿。

### 本地验证

- Vitest：`77 passed | 2 skipped` test files，`689 passed | 3 skipped` tests；
- electron-vite production build：通过；
- release shell scripts `bash -n`：通过；
- 全部 workflow YAML：解析通过；
- 更新错误 Banner：真实 Electron 桌面与 420 px 窄窗口 E2E 通过，覆盖 hover、关闭、组件边界与横向溢出；
- 官网：中英文桌面与 390 px 手机全页回看通过；Gatekeeper FAQ 展开、滚动与横向溢出检查通过。

## 零发布复核

任务结束时公开 Release 列表仍只有 `v1.2.0`、`v1.1.0`、`v1.0.0`；最新公开版本仍为 2026-07-18 发布的 `v1.2.0`。成功空跑的 GitHub API artifact 数为 `0`。当前仓库版本仍为：

```text
package.json              1.2.0
package-lock.json         1.2.0
package-lock packages[""] 1.2.0
```

## 尚未执行且不得混淆的事项

- 没有 bump `v1.3.0`；
- 没有创建或推送 release tag；
- 没有运行 credentialed signing smoke；既有签名能力证据仍为成功 run `29727895945`；
- 没有生成真实 `v1.3.0 → v1.3.1` 两份签名候选，因此没有运行真实更新 E2E；
- 没有上传 canary 或 stable metadata；
- `promote-macos-update.yml` 需要标签为 `swob-update-canary` 的专用 GUI self-hosted Mac，并需要该机器上安装上一正式签名版。

以上事项属于后续发布终审，不是 t120 空跑的一部分。合并本分支不会自动发布任何版本。

## 建议的后续顺序

1. 负责人审查并合并本分支；
2. 经 yyt 终审后，在独立发布提交中同步 bump 三处版本为 `1.3.0`；
3. 运行 credentialed signing smoke，确认五个 Actions Secret 和固定 Team ID；
4. 创建 `v1.3.0` tag，发布手动迁移版，确认远端没有任何 update metadata；
5. 配置专用 canary Mac，并保留已安装、已签名的 `v1.3.0`；
6. 发布六个 `v1.3.1` 候选资产；
7. 手动运行 promotion workflow；只有真实安装重启 E2E 通过后才开放 `swob-signed-mac.yml`；
8. 完成以上证据后，才对外宣称签名版本间自动更新可用。
