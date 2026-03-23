# 自动更新计划

让用户打开 Swob 时自动检查新版本、下载安装，不用手动下 DMG。

## 技术方案

使用 `electron-updater` + GitHub Releases。这是 Electron 生态最成熟的方案。

流程：
1. 你在 master 上 commit + push
2. GitHub Actions 自动打包 DMG + 发布到 GitHub Releases
3. 用户打开 Swob → 后台检查 GitHub Releases 有没有新版本
4. 有新版 → 自动下载 → 提示用户"有新版本，重启即可更新"
5. 用户点重启 → 自动替换 → 完成

## ⚠️ 代码签名问题

现在没有 Apple Developer 证书（`0 valid identities found`）。

**没有签名的后果：**
- macOS 会弹"无法验证开发者"警告（用户可以右键打开绕过，但体验差）
- `electron-updater` 的自动更新在未签名时**仍然可以工作**，但用户首次安装需要手动信任

**已解决：** 证书已安装。
- Developer ID Application: `Yuntong Yang (ZPTA4LP594)`
- Team ID: `ZPTA4LP594`

electron-builder.yml 里加上签名配置即可自动签名。

## 实现步骤

### 第一步：安装 electron-updater

```bash
npm install electron-updater
```

### 第二步：修改 electron-builder.yml

```yaml
appId: com.swob.app
productName: Swob
directories:
  buildResources: build
files:
  - '!**/.vscode/*'
  - '!src/*'
  - '!electron.vite.config.*'
  - '!{tsconfig,tsconfig.*}.json'
mac:
  target:
    - target: dmg
      arch:
        - arm64
        - x64
  artifactName: swob-${version}-${arch}.${ext}
publish:
  provider: github
  owner: IvyYang1999
  repo: swob
```

### 第三步：在 main 进程加自动更新检查

在 `src/main/index.ts` 的 `app.whenReady()` 中加：

```typescript
import { autoUpdater } from 'electron-updater'

// 启动后静默检查更新
autoUpdater.checkForUpdatesAndNotify()
```

`autoUpdater` 会：
- 启动时自动检查 GitHub Releases
- 有新版本自动下载
- 下载完弹系统通知"新版本已就绪，重启即可更新"
- 用户点击后自动安装重启

### 第四步：加 GitHub Actions 自动发版

创建 `.github/workflows/release.yml`，在打 tag 时自动：
1. 编译
2. 打包 DMG（arm64 + x64）
3. 发布到 GitHub Releases

### 第五步：修改版本号流程

以后发版流程变成：
1. 改 `package.json` 里的 `version`（比如 `1.0.0` → `1.1.0`）
2. commit + push
3. 打 tag：`git tag v1.1.0 && git push origin v1.1.0`
4. GitHub Actions 自动打包 + 发布
5. 用户下次打开 Swob 自动收到更新

## 注意事项

- `electron-updater` 对比的是 `package.json` 的 `version` 和 GitHub Releases 的 tag
- 版本号必须用 semver 格式（x.y.z）
- 不需要每次 commit 都发版，只有想推给用户时才打 tag
- post-commit hook 的自动部署只影响你本地的 `/Applications/Swob.app`，不影响用户
