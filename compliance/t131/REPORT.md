# Swob Apache-2.0 重许可最终工程审计

- 审计单：t131（t140 发布候选增量复核）
- 审计日期：2026-07-23
- 产品基线：`45fccdd12536f4ecad5bcc12e8b4f067317452e4`
- 结论：**PR / 合并 GO；公开发布仍以最终提交和合并后 master 的远程签名冒烟通过为前提**
- 性质：工程来源与分发证据审计，不构成法律意见

## 1. 决策结论

原 t131 的来源、资产、依赖和打包堵点已经在产品基线上闭合到可以评审和合并的程度：

1. Apache-2.0 与 1.3.0 在同一提交生效；v1.2.0 及更早版本没有被追溯改写，公开站点中的 v1.2.0 结构化数据仍指向 AGPL-3.0。
2. owner 权利链声明和 IP assignment 已在私有档案中完成签署。仓库只记录 hash、页数和签署栏完成状态，不提交签名或个人信息。
3. 64 个 tracked 视觉资产全部由 hash 绑定的证据清单覆盖。无法闭合再分发依据的 Claude、Cursor、OpenAI 品牌图已从运行时删除，改为 Swob 自有中性 glyph。
4. 当前 `package-lock.json` 的 910 个 package entry 已重新生成依赖清单和两份 CycloneDX 1.6 SBOM；`npm ls --package-lock-only --all` 与不忽略 npm 错误的 SBOM 生成均通过。源码中使用的 Minimal/Nord 配色还通过静态清单保留完整 MIT notice。
5. 当前产品源码与 v1.0.0、v1.1.0、v1.2.0 快照已重新对固定 20 仓库语料扫描：完整文件、规范化 16 行、80-token、AST 子树均为 0 命中，人工候选为 0。
6. 打包输入改为运行时 allowlist，并对 `app.asar` 和外层 notices fail closed；历史 v1.2.0 包含本地 worktree 的事故不再能通过当前门禁。
7. 发布校验器统一验证 unpacked、ZIP 解包和 DMG 挂载后的每一份 app：Developer ID、Team ID、hardened runtime、Gatekeeper、notarization、版本/通道以及包体 allowlist。发布资产必须恰好六个，且不能出现 update metadata 或 DMG blockmap；credentialed signing smoke 也会显式执行完整仓库门禁。

因此可以提交 PR 并在 CI 全绿后合并。这里的 GO **不是**“可以现在上传二进制”：最终公开发布仍必须满足同一 final SHA 上的 `release-gates` 与 credentialed `signing-smoke`，并在合并后的 master 再各跑一次。tag 必须等于当时 `origin/master` 的 tip；tag 到 Release 公开期间需要冻结 master。tag、GitHub Release、更新元数据和 Pages 发布由 owner 单独执行。

## 2. 许可证与版本边界

产品基线一次性完成：

- 根 `LICENSE`、`package.json`、README、网站与 CLI：Apache-2.0 / 1.3.0。
- `NOTICE` 与可复现的 `THIRD_PARTY_NOTICES`：随应用内外层分发。
- `CHANGELOG.md` / `CHANGELOG.zh.md`：明确 Apache-2.0 从 1.3.0 生效。
- 网站 v1.2.0 `SoftwareApplication` JSON-LD：继续标注 AGPL-3.0；当前源码和 1.3.0 文案标注 Apache-2.0。

`npm run check:public-copy` 会同时验证版本、许可边界和实际 harness 能力口径（6 个原生、1 个兼容、4 个仅检测），防止网站或 README 再把旧版本写成 Apache，或把 11 个来源都写成原生支持。

## 3. 权利链与贡献门禁

Git 可见历史仍只有一个实际写入源码/资产的 owner 身份和一个纯 merge 自动化身份。Git 本身不能证明 AI 辅助过程，因此 owner 的 rights-chain declaration 和 IP assignment 由私有签署档案补足。`private-attestation-evidence.json` 只保存文件 hash 和结构化复核结果，不包含签名、姓名图像或 PDF。

从 1.3.0 起，`CONTRIBUTING.md` 要求 DCO；PR CI 使用真实 base/head 范围验证每个新提交的 `Signed-off-by`。本候选的产品提交和审计提交均按该规则签署。

## 4. 资产来源

当前 inventory 有 64 个 tracked 视觉资产，覆盖：

- 15 个 owner 已确认的自有品牌/产品截图；
- 6 个 Swob 自有中性 provider glyph；
- 12 个 Session Galaxy 正式源图及确定性衍生物；
- 25 个公开页面或合成数据验收截图；
- 6 个 t156 本地品牌验收截图。

`asset-evidence-manifest.json` 为每组记录成员和聚合 SHA-256。`npm run check:asset-evidence` 对新增、缺失、字节变化和集合漂移全部失败；仅复用路径名不能继承 clearance。正式图标源和 11 个输出另由 `build/brand/icon-manifest.json` 与 `npm run icons:check` 双重约束。

## 5. 依赖、SBOM 与 notices

当前 lockfile 共 910 个 package entry：

- 883 个 permissive / public-domain 分类；
- 26 个需要人工 copyleft 复核的开发依赖；
- 1 个需要 attribution 复核的开发依赖。

生产侧共 214 个 lock entry，只出现 MIT、ISC、BSD、Apache-2.0、Python-2.0、BlueOak-1.0.0 和组合式宽松许可证；没有生产 GPL、AGPL、LGPL、MPL、source-available 或 unknown 元数据。

开发侧的 12 个 `lightningcss` MPL-2.0 项，以及 `sharp`/libvips 链的 LGPL/组合许可证项，只用于构建或开发，并由最终包 allowlist 验证不作为 Swob 自有源码或运行时包分发。`caniuse-lite` 的 CC-BY-4.0 项也是开发侧；当前包体校验禁止把开发树带入产物。

两份 CycloneDX 1.6 SBOM：

| 文件 | components | dependency nodes |
| --- | ---: | ---: |
| `sbom-production.cdx.json` | 192 | 215 |
| `sbom-development.cdx.json` | 745 | 911 |

`THIRD_PARTY_NOTICES` 由锁文件和 `compliance/third-party-static-notices.json` 确定性生成，当前覆盖 201 个生产包以及 Minimal for Obsidian、Nord 两项非 npm 来源；输入文件 hash 也写入生成结果，`npm run notices:check` 已通过。

## 6. 当前源码扫描

### ScanCode

ScanCode Toolkit 32.5.0 对产品基线 Git archive 做本地 license、copyright、package、info 和 classify 扫描。原始 JSON 只保留在本地临时审计区；提交仓库的 summary 不含机器路径或源码片段。

### 固定语料相似度

20 个外部仓库均固定到 `source-corpus.lock.json` 记录的 commit。目标包含当前产品基线和 v1.0.0、v1.1.0、v1.2.0 三个快照：

- 592 个 source file-snapshot，约 5.27 MB；
- 88,792 个规范化 16 行窗口；
- 827,459 个 80-token 窗口；
- 2,463 个 TypeScript/JavaScript AST 片段；
- 完整文件、规范化行、token、AST 命中：全部 0；
- 人工候选：0。

语料共接受 18,304 个文件、约 172.45 MB。扫描排除依赖、vendor、build/generated 输出、lockfile、source map、minified 文件和法定重复的 LICENSE/NOTICE；这只证明指定固定语料内没有识别到复制，不是全互联网原创性或法律保证。

## 7. 打包与签名边界

历史 v1.2.0 DMG/ZIP 的 `app.asar` 曾包含 `.claude/worktrees` 下 58 个非发行文件，且 macOS 外层 notices 不完整。该历史事实保留在 `artifact-inventory.json`，不会因重许可被抹去。

当前基线采取三层控制：

1. `electron-builder.yml` 只列出运行时输出、package metadata 和法定文本，并显式排除私有 worktree、审计、网站、测试、文档和脚本树。
2. `npm run check:package` 检查每个 app 的 `app.asar` 路径和外层 `LICENSE`、`NOTICE`、`THIRD_PARTY_NOTICES`、Electron/Chromium notices；拒绝隐藏目录、环境/凭据类路径、源文件和开发树。
3. `verify-macos-artifacts.sh` 对 unpacked、ZIP 和 mounted DMG 的 app 逐一执行签名、Team ID、hardened runtime、Gatekeeper、stapler、版本/更新通道和 package allowlist 校验。

本地无凭据构建只证明内容、命名和恰好六项资产合同，不能证明签名和 notarization。最终签名证据只能来自 GitHub 上同一 final SHA 的 credentialed smoke；该条件在 PR 合并前和 master 合并后都必须满足。

## 8. 仍然保留的边界

- 本审计不是法律意见，也不是全互联网原创性保证。
- Windows alpha 仍是独立、非正式、未签名范围；它不能替代 macOS 1.3.0 正式候选的签名证据。
- 本轮没有创建 tag、GitHub Release、update metadata，也没有部署 Pages。
- owner 在最终发布前仍需核对远程 workflow 的 `headSha` 与预期 final SHA 一致；任何不一致都视为未验收。

## 9. 证据索引

- `rights-chain.json` / `private-attestation-evidence.json`：匿名 Git 权利链与私有签署档案的脱敏存在性证据。
- `asset-evidence-manifest.json` / `asset-provenance.csv`：hash 绑定的资产来源和处置。
- `dependency-license-inventory.csv` / `dependency-license-summary.json`：逐包许可证与聚合。
- `sbom-production.cdx.json` / `sbom-development.cdx.json`：CycloneDX 1.6 SBOM。
- `scancode-summary.json`：当前基线的本地 ScanCode 脱敏摘要。
- `source-corpus.lock.json` / `similarity-summary.json`：固定语料和当前增量相似度结论。
- `artifact-inventory.json`：历史事故、当前本地无签名证据和远程签名前置条件。
- `manual-review.csv`：A–F 人工分类与关闭状态。
- `docs/reports/2026-07-23-v1.3.0-release-checklist.md`：发布操作者逐项清单。
