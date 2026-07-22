# Swob Apache-2.0 重许可前源码、资产与依赖来源审计

- 审计单：t131
- 审计日期：2026-07-22
- 基线：`dc6bf2409640248bc75b3a22fadfea6636f69383`（审计开始时最新 `origin/master`）
- 分支：`audit/t131-apache-relicense-provenance`
- 结论：**NO-GO**
- 性质：工程来源与分发证据审计，不构成法律意见

## 1. 决策结论

当前**不能**直接把 Swob 从 AGPL-3.0-only 改为 Apache-2.0，也不能据此发布新的 Apache 安装包。

原因不是扫描发现了竞品代码抄袭。相反，在本次明确范围内，源码侧结果较干净：20 个固定 commit 的外部仓库、Swob 当前源码与 v1.0.0/v1.1.0/v1.2.0 三个历史快照之间，精确文件、去注释/空白后的连续 16 行、连续 80 token、TypeScript/JavaScript AST 子树匹配均为 0；唯一四条人工候选是 Codex JSONL 协议字段重合，已判定为协议约束下的独立实现。

NO-GO 来自六个仍无法用事实闭合的环节：

1. **权利链声明未签署**：Git 只能证明一个实际写入代码的 owner 身份和一个纯 merge 自动化身份，无法区分 owner 身份下哪些行由 Claude 辅助生成，也无法单凭 Git 证明输入中没有第三方代码。
2. **21 个图片/图标资产没有来源证明**：其中 3 个是 Claude、Cursor、OpenAI 品牌图标，仓库内没有来源 URL、再分发条款或替换依据；其余品牌图、产品截图与生成衍生图也没有生成器、原图权利和脱敏记录。
3. **v1.2.0 macOS 公共安装包包含意外工作树**：DMG/ZIP 的相同 `app.asar` 中有 `.claude/worktrees/...` 下 58 个文件，其中含一个本地 settings 文件路径。为遵守隐私边界，本审计没有读取其内容。该包必须按打包/隐私事故处理。
4. **macOS 分发 notices 不完整**：检查到项目 AGPL 文本和大量 npm 包 license，但外层包内没有 Windows 样本中存在的 `LICENSE.electron.txt` 与 `LICENSES.chromium.html`。
5. **没有当前基线的最终包证据**：正式 release 只有旧的 macOS DMG/ZIP；NSIS 只有另一分支的 alpha CI 样本。修复后必须按当前待重许可代码重新构建并解包审计三种格式。
6. **开发依赖图存在锁文件一致性缺口**：CycloneDX 文件已生成并通过 schema 校验，但 npm 报告 `@tailwindcss/oxide-wasm32-wasi` 的 6 个可选 WASM 边缺失。它不影响已识别的生产依赖结论，却意味着“完整开发依赖图”尚不能声明无缺口。

最短可靠路径不是现在改 LICENSE，而是先补权利声明和资产证据、修复打包 allowlist/notices、重建三类产物，再把本审计增量重跑。完成这些动作后，源码与生产依赖证据表明 Apache-2.0 **有较高概率可行**；在此之前结论必须保持 NO-GO。

## 2. 审计范围与边界

### 已扫描

- `src/main`、`src/preload`、`src/renderer`、`src/shared`、`src/cli`、`scripts`、`e2e`。
- 官网代码、文案和构建/发布配置。
- 所有受 Git 跟踪的图片、Logo、图标、字体、截图和生成图片衍生物。
- `origin/master` 可达历史中删除过的源码/视觉资产路径，以及 v1.0.0、v1.1.0、v1.2.0 标签快照。
- `package-lock.json` 中生产、开发、原生、可选依赖；Electron runtime。
- v1.2.0 官方 macOS arm64 DMG/ZIP，和 Windows alpha CI 的 NSIS 样本。
- 前置报告列出的所有外部源码仓库，固定到 `source-corpus.lock.json` 的 20 个 commit。

### 明确没有做

- 没有改产品逻辑、`LICENSE`、`package.json` 的 SPDX、README/官网许可文案、历史 commit/tag。
- 没有上传源码、二进制、资产或扫描结果到在线扫描服务。
- 没有读取 transcript 正文、`.env`、凭据、Keychain/keykeeper 值，或安装包中本地 settings 文件的内容。
- 没有视觉打开产品截图验证其中的真实内容和脱敏状态；缺少的不是“工具结果”，而是 owner 的来源/脱敏声明，因此按 blocker 处理。
- 相似性结果只覆盖列明的 20 个仓库和 4 个 Swob 快照，不是全互联网原创性保证。
- 没有当前基线的可发布 DMG/ZIP/NSIS，因此没有把旧包结果冒充成未来 Apache 包结果。

完整 tracked 范围统计见 `scope-inventory.json`；基线有 413 个 tracked 文件。

## 3. 权利链

| 匿名身份 | commits | merge commits | 行变更 | 二进制变更 | 结论 |
| --- | ---: | ---: | ---: | ---: | --- |
| `PROJECT_OWNER` | 395 | 44 | +117,566 / -18,744 | 28 | 唯一可见的实际源码/资产提交身份 |
| `MERGE_AUTOMATION` | 18 | 18 | 0 | 0 | 纯 merge 元数据，不构成独立代码贡献 |

没有第三个可识别的人类 author，也没有单独的 Claude 行作者身份。这个结果比“两个贡献者＝owner + Claude”的口头表述更精确：第二个 Git 身份没有直接行变更，而 Claude 辅助工作被提交在 owner 身份下。Git 无法证明辅助生成过程、prompt 输入或粘贴来源，所以必须由 owner 做权利声明。

### 内部声明草案（需 owner 签署/留档）

> 我确认，Swob 截至 commit `dc6bf2409640248bc75b3a22fadfea6636f69383` 的、以 `PROJECT_OWNER` 身份提交的代码和自有资产，均由我创作或在我的指示下通过 Claude 等自动化工具生成。相关自动化工具不是另一个需要签署重许可同意的外部自然人贡献者。我拥有或已取得将这些成果以 Apache-2.0 发布所需的权利。除仓库中已列明并按其许可证使用的依赖/素材外，我没有要求工具复制、也没有 knowingly 粘贴第三方受保护源码；若后续发现例外，我会先移除、取得许可或安排隔离的 clean-room 重写，再进行重许可。

建议声明附签署人、日期、基线 commit，并与本报告一起存档。若未来接受外部贡献，再引入 DCO 或 CLA；不要把本声明泛化到未来 commit。

## 4. 源码许可证与归属扫描

ScanCode Toolkit 32.5.0 从官方 tag 本地构建 Docker image，对基线 Git archive 的 405 个文件执行 license/copyright/package/info/classify 扫描：0 error、0 warning。

结果：

- 当前 `LICENSE`、package metadata、README/官网文案正确反映现状 AGPL-3.0；本任务没有修改它们。
- 产品源码文件中没有检测到第三方 SPDX/license/copyright header。
- 唯一 copyright 命中是根 AGPL 文本里的 Free Software Foundation notice。
- 没有发现 vendored source tree。

这说明仓库里没有明显“带着别人的 header 被拷入”的源码，但不能反向证明作者权；因此它与权利声明、相似性、依赖和包体审计组合使用。脱敏结果在 `scancode-summary.json`，完整 raw JSON 只留本机临时审计区。

## 5. 依赖、SBOM 与人工许可证复核

### SBOM

用 `@cyclonedx/cyclonedx-npm` 4.1.1 生成 CycloneDX 1.6、reproducible、schema-validated SBOM：

| 文件 | components | dependency nodes | 用途 |
| --- | ---: | ---: | --- |
| `sbom-production.cdx.json` | 167 | 181 | 生产解析图 |
| `sbom-development.cdx.json` | 707 | 850 | 含开发工具的解析图 |

生产 SBOM 明确包含 Electron 40.10.6、`better-sqlite3` 13.0.1 和可选 `fsevents` 2.3.3，三者 package metadata 均为 MIT。SBOM 是 npm manifest/lock 视角，不能替代 Chromium/Electron 自带第三方 notices，也不能替代最终 `app.asar`/安装包 inventory。

### lockfile 许可证结果

共 849 个 package-lock entry：生产 180、开发 669。生产许可证仅出现 MIT、ISC、BSD-2-Clause、BSD-3-Clause、Apache-2.0、Python-2.0、BlueOak-1.0.0 和 `MIT AND ISC`；没有生产 GPL/AGPL/LGPL/MPL/source-available/unknown 元数据。

需要保留的人工项：

- `lightningcss` 及其平台包共 12 个 MPL-2.0 entry，均为开发侧。已检查的发行 payload 没有把它们作为运行时包分发。结论是 file-level copyleft 不扩展到 Swob 自有源码，但 CI 应持续验证它们不进入产物。
- `caniuse-lite` 是 1 个开发侧 CC-BY-4.0 entry。若只作为构建数据且不把需署名内容复制进分发结果，风险有限；否则需要相应 attribution。当前标记为 open action。
- 两个比较仓库在固定 commit 没有充分根许可证证据，只允许作为 comparison corpus，不允许复制。
- 开发依赖图的 6 个缺失边全部来自可选 `@tailwindcss/oxide-wasm32-wasi` 链。须重建/修复 lockfile 后用不带 `--ignore-npm-errors` 的 CycloneDX 命令通过，才可关闭完整性 blocker。

逐包 CSV 见 `dependency-license-inventory.csv`，聚合见 `dependency-license-summary.json`，人工分类见 `manual-review.csv`。

## 6. 图片、图标、字体与生成内容

共 21 个 tracked 视觉资产：

- 3 个自有品牌类：`build/icon.icns`、`build/icon.png`、官网 favicon；缺创作/生成来源声明。
- 11 个 PNG 产品/营销截图（其中 `docs/screenshot.png` 与 `site/assets/main.png` 是同一文件）；缺截图主体权利、生成/编辑过程和脱敏记录。
- 4 个 WebP 衍生图；由同名 PNG 派生的关系可推断，但仓库未记录生成命令，且源 PNG 自身尚未 clearance。
- 3 个第三方品牌图标：Claude、Cursor、OpenAI；commit subject 写“官方品牌图标”不能替代来源 URL、商标/品牌规范和再分发依据。
- 0 个字体文件；官网 CSS 使用系统 font stack，没有外部 webfont 下载。

这些资产不能因为“AI 处理过”就自动获得清晰来源。最快的处置方式：

1. owner 对确属自创/自有产品截图的项目补一份逐文件 provenance + 脱敏声明；记录生成/编辑工具和日期，不需要保存私密 prompt 或原始敏感截图。
2. 对第三方品牌图标记录官方源 URL、品牌规范版本和允许的使用方式；如果条款不清，换成 Swob 自有的中性 provider glyph/文字标签。
3. 把 PNG→WebP 的确定性命令写进脚本或构建说明，由 cleared 源文件生成。

逐项证据、hash、首次 commit 和 blocker 在 `asset-provenance.csv`。本报告不展示截图，避免把可能含隐私的视觉内容继续复制到审计材料。

## 7. 历史删除文件与发行边界

`origin/master` 可达历史里有 10 个删除过的源码/视觉资产路径，覆盖旧 Insights、Settings、Graph 实现和官网截图。逐个检查 v1.0.0/v1.1.0/v1.2.0 tag tree，均不在这三个正式发行标签中；见 `history-deletions.json`。

但 v1.2.0 二进制揭示了更严重的另一条路径：未被 release tag 跟踪的本地 worktree 文件被打进了 `app.asar`。因此“tag 不含该文件”并不能证明“包不含该文件”，最终包 inventory 必须是发布门禁。

## 8. DMG / ZIP / NSIS 解包结论

| 样本 | 来源 | hash 固定 | 实际发现 | 状态 |
| --- | --- | --- | --- | --- |
| v1.2.0 macOS arm64 DMG | 正式 GitHub Release，commit `9bd6bbc...` | 是 | 与 ZIP 的 `app.asar` 完全相同 | BLOCKED |
| v1.2.0 macOS arm64 ZIP | 正式 GitHub Release | 是 | 8,869 个 asar 文件；带项目/包 license；带 58 个意外 worktree 文件；缺 Electron/Chromium notice 文件 | BLOCKED |
| 1.2.0 Windows x64 NSIS | `feature/t107-windows-alpha` CI，commit `d970cbf...` | 是 | 8,971 个 asar 文件；外层有 Electron/Chromium notices；无 `.claude` 文件 | 参考样本，不代表 master 正式发行 |

macOS 意外 worktree 中：23 个文件与 v1.2.0 tag 完全一致、27 个内容不同、8 个在 tag 中不存在。一个不存在于 tag 的路径属于本地 settings 类。没有读取、输出或 hash 其内容；owner 应在本机私下确认是否含秘密，并按需要轮换/作废。无论内容是否敏感，这 58 个文件都证明当前打包边界失效。

根因不是 `.gitignore` 本身，而是发行包缺少强 allowlist/denylist 验证。修复任务至少应：

- 在 electron-builder `files` 中明确排除 `**/.claude/**`、`.git`、worktree、审计临时目录、测试/文档等非运行时路径，最好改成可解释的 allowlist。
- build 后自动列出 `app.asar` 和 outer payload，若出现隐藏目录、settings/env/key/cookie 类路径立即失败。
- 确保三平台都携带项目 LICENSE、Electron/Chromium notices 和生成的 `THIRD_PARTY_NOTICES`。
- 对 DMG/ZIP/NSIS 做同一份 policy 检查，不接受“另一个平台有 notices”作为替代。

完整脱敏 inventory 见 `artifact-inventory.json`。原始文件列表因可能暴露本机路径和内部文件名，留在 Git 外。

## 9. 源码相似性审计

### 语料与方法

语料包含前置报告明确列出的 20 个 GitHub 源码仓库；每个 repo 的 commit、日期、角色和当时根许可证证据见 `source-corpus.lock.json`。其中包括直接竞品，也包括 Continue、Logseq、Superset、Zed 等明确源码参考/相邻项目。

目标是当前源码与 v1.0.0/v1.1.0/v1.2.0 三个 snapshot，共 499 个 source file-snapshot、约 4.42 MB。执行四层匹配：

1. 完整文件 SHA-256。
2. 去 block/line/HTML 注释和空白后的连续 16 个非平凡行，窗口至少 240 字符。
3. 去注释后的连续 80 token。
4. TypeScript/JavaScript 去标识符和 literal 的精确 AST 子树，至少 60 nodes。

另用长标识符/字符串做人工候选路由，但 committed summary 不保存具体 literal。依赖、vendor、build/generated 输出、lockfile、source map、minified 文件和法定重复的 LICENSE/NOTICE/COPYING 被排除；超过 8 次的 fingerprint 视为 framework/syntax boilerplate。

### 结果与人工结论

- 完整文件匹配：0
- 规范化 16 行匹配：0
- 80-token 匹配：0
- AST 子树匹配：0
- 稀有词人工候选：4（实为当前/v1.2.0 × 同一外部 repo 两个文件）

四条候选都是 `src/main/codex-loader.ts` 与 `HizTam/codex-history-viewer` 两个 Codex transcript renderer 文件的协议词重合。外部文件较早出现，但双方都在读取同一 Codex JSONL schema。逐文件人工检查发现控制流、输出模型和结构不同，没有连续源码或 AST 匹配；分类为 `B_PROTOCOL_BOILERPLATE_INDEPENDENT_IMPLEMENTATION`，关闭。

一个早期 dry run 还报过 React 文件 token 相似。追根因后发现匹配的是注释装饰分隔线，不是代码；tokenizer 已改为先删注释，最终结果中该误报消失。这个修正被记录在 `similarity-summary.json`，防止以扫描器缺陷制造“抄袭”结论。

结论只说明：在任务指定、固定 commit 的语料中，没有找到需要 attribution、移除或 clean-room 重写的源码匹配。它不覆盖未列明的互联网仓库，也不取代 owner 权利声明。

## 10. A–F 人工分类总表

| 类别 | 本次项目 | 状态 |
| --- | --- | --- |
| A 原创 | Swob tracked product source；没有结构性相似命中 | 关闭，保留增量扫描门禁 |
| B boilerplate/协议约束 | Codex JSONL 字段 overlap；早期注释分隔线误报 | 关闭 |
| C 合法宽松许可 | 生产 npm/Electron/native 依赖 | 条件可用；需 notices |
| D file-level copyleft | dev-only `lightningcss` MPL-2.0 | 关闭并持续验证不分发 |
| E 强 copyleft/source-available/无许可 | Logseq/Superset/Zed 和 2 个无许可证 repo 仅作为 comparison corpus；无 match | 关闭；禁止复制 |
| F 来源不明 | 资产、AI 权利声明、macOS 意外包体、当前安装包、缺 notices | **BLOCKER** |

`manual-review.csv` 给出每一项的证据、结论、动作和 reviewer 状态。未知项没有被包装成“未发现”。

## 11. 解除 NO-GO 的顺序

1. **owner 书面确认权利链**：签署第 3 节草案；逐项补 `asset-provenance.csv` 的来源/生成/脱敏/许可信息，或移除/替换无法证明的资产。
2. **单独修复打包边界**：建立 allowlist、隐藏/敏感路径 deny check、跨平台 LICENSE/notices/`THIRD_PARTY_NOTICES` 生成与验证。不要在本审计 commit 混入产品配置修改。
3. **修复 lockfile 图**：让 `npm ls --package-lock-only --all` 无缺失边，再不忽略 npm error 重建两份 SBOM。
4. **从拟重许可 commit 构建正式候选**：macOS DMG + ZIP、Windows NSIS 全部解包；对 `app.asar`、outer runtime、原生模块、可选依赖、fonts、licenses/notices 做 policy 检查。
5. **增量重跑本审计**：新增/变化源码跑 ScanCode + 多层 similarity；资产和包体逐项清零 blocker。
6. **全部关闭后再开重许可 PR**：同一个原子 PR 中改 LICENSE、package SPDX、README/官网文案，新增 NOTICE/THIRD_PARTY_NOTICES，并记录生效 commit/版本。不要回写历史 tag。

只有 1–5 全部有可复核证据后，t131 才能从 NO-GO 改为 GO。

## 12. 复现索引

- `rights-chain.json`：匿名 Git 权利链统计。
- `scope-inventory.json`：tracked 范围统计。
- `scancode-summary.json`：ScanCode 版本、输入和脱敏结果。
- `dependency-license-inventory.csv` / `dependency-license-summary.json`：逐包与聚合许可证。
- `sbom-production.cdx.json` / `sbom-development.cdx.json`：CycloneDX 1.6 SBOM。
- `asset-provenance.csv`：资产 hash、首次 commit、证据和 disposition。
- `history-deletions.json`：历史删除路径与 release-tag 检查。
- `artifact-inventory.json`：DMG/ZIP/NSIS hash、计数、notices 与包体 blocker。
- `source-corpus.lock.json`：20 个外部 repo 的固定 commit/许可证据。
- `similarity-summary.json`：最终扫描统计、排除项与人工结论。
- `manual-review.csv`：A–F 人工处置表。
- `scripts/compliance/README.md`：本地复现命令和工具版本。

原始 ScanCode、相似性、安装包和解包清单保留在本机临时审计区，未提交、未上传；报告只保留决策所需的脱敏证据。
