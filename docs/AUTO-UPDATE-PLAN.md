# macOS 自动更新与签名信任根

## 当前结论

Swob 的 Developer ID 签名、公证、Gatekeeper 与 stapling 已在 GitHub Actions smoke run `29727895945` 跑通，但公开 v1.2.0 不能自动迁移到首个正式签名版本：

- arm64 v1.2.0 是 ad-hoc 签名，designated requirement 绑定当前构建的精确 CDHash；
- x64 v1.2.0 完全未签名；
- 两者都不能成为 Squirrel.Mac 后续正式签名更新的信任起点。

因此，v1.2.0 用户必须从官网或 GitHub Release **手动覆盖安装首个正式签名版本一次**。这次迁移之后，正式签名版本之间才启用自动更新。

## 通道隔离

旧版与正式签名版不能共享更新 feed：

```text
v1.2.0
  └── latest-mac.yml（永久退役；后续 Release 不再上传）

首个正式签名版及以后
  └── swob-signed-mac.yml
      └── 只有真实 canary 安装与重启 E2E 通过后才上传
```

`electron-builder.yml` 中固定：

```yaml
publish:
  provider: github
  owner: IvyYang1999
  repo: swob
  channel: swob-signed
  publishAutoUpdate: false
```

`publishAutoUpdate: false` 是发布安全门：electron-builder 可以把 `swob-signed` 写入 packaged `app-update.yml`，但普通 tag workflow 无权自动上传更新 metadata。

## 发布职责分离

### `release.yml`：只发布可手动安装的不可变资产

Tag 发布流程：

1. 断言 `tag = package.json = package-lock.json`；
2. 断言版本不低于首个签名信任根 `1.3.0`；
3. Apple 公证凭据预检；
4. 在干净 checkout 中运行 `npm ci`，拒绝 symlink `node_modules`；
5. 运行全量测试；
6. `electron-builder --publish never` 构建、签名、公证；
7. 验证 Developer ID、Team ID、Bundle ID、版本、架构、Gatekeeper、stapler、DMG、ZIP 与 metadata；
8. 创建 draft Release，只上传两个 DMG、两个 ZIP、两个 blockmap；
9. 从 GitHub 重新读取并核对每个资产的名称、大小与 SHA-256 digest；
10. 全部通过后才把 draft 转为正式 Release，失败则清理 draft；
11. 不上传 `latest-mac.yml`，也不上传 `swob-signed-mac.yml`。

`v1.3.0` 是一次性手动信任根迁移版，Release notes 必须包含手动覆盖安装说明。

### `promote-macos-update.yml`：真实 E2E 后开放自动更新

该 workflow 只能手动触发，并且必须运行在专用 GUI Mac：

1. 候选 Release 必须已经存在，且只能包含六个已验收的不可变安装资产；
2. 从候选的真实 arm64/x64 ZIP 计算 `swob-canary-mac.yml`；
3. 临时上传 canary metadata；
4. 启动已安装的上一正式版本；
5. 强制走 `swob-canary`，检查指定候选版本；
6. 下载、Squirrel 安装、退出并重新启动；
7. 验证重启后的版本、Developer ID、Team ID、Gatekeeper 与 stapled ticket；
8. 成功后把同一份 metadata 晋升为 `swob-signed-mac.yml`；
9. 删除 canary metadata；
10. 任一步失败都删除临时 metadata，禁止 stable promotion。

`v1.3.0` 被 workflow 明确禁止发布自动更新 metadata。

## 本地与 CI 验证

### 零副作用门禁空跑

手动运行 `Release Gates Dry Run`：

- 使用干净 `npm ci` 依赖树；
- 证明版本不一致会失败；
- 证明缺 Apple 凭据会失败；
- 构建一份 unsigned 目录 fixture，证明签名门禁会拒绝；
- 运行全量测试和编译；
- 不创建 tag、Release、release asset 或 workflow artifact。

### 正式签名 smoke

`macOS Signing Smoke Test` 继续验证签名、公证和独立安装。它不等于自动更新 E2E。

### 本地开发包

`npm run deploy` 生成 unsigned `--dir` 包，通常没有可用的线上更新上下文。它不能代表公开 Release，也不能用于判定自动更新是否正常。

## 用户可见错误

后台自动检查失败保持安静，不中断 Swob；用户主动检查、下载或安装失败必须给出可恢复路径：

- 已是最新版：明确确认；
- 检查失败：允许打开官方 Release 页手动下载；
- 下载失败：提供重试；
- 安全校验/安装失败：明确说明未安装新版，并提供官方手动下载入口。

Renderer 只接收错误类别，不接收原始 updater error，避免把路径、请求或环境信息带进界面和日志。

## 不允许的操作

- 不再为任何新 Release 上传 `latest-mac.yml`；
- 不让 `release.yml` 直接调用 `electron-builder --publish always`；
- 不在真实 E2E 之前上传 `swob-signed-mac.yml`；
- 不删除 blockmap 来换发布页整洁；
- 不用 `xattr -cr` 作为正式签名版的安装方案；
- 不覆盖已经发布的同版本 ZIP/DMG；
- 不在日志、文档或参数中输出 Apple/GitHub Secret。

## v1.2.0 用户文案

> **首个正式签名版需要手动更新一次。**Swob v1.2.0 使用了早期 macOS 构建签名，无法安全地自动迁移到新的 Developer ID 正式签名版本。新版本发布后，请从 Swob 官网或 GitHub Release 下载与你的 Mac 匹配的 DMG，并覆盖安装一次。完成迁移后，后续版本将通过新的安全更新通道提供。
