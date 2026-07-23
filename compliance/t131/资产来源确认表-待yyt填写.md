# Swob 资产来源确认表（已填写）

> 用途：关闭 t131 的 21 项视觉资产来源堵点。请逐项填写；不确定或无法证明时不要猜，直接写“无法确认”并选择移除/替换。不要在本表粘贴密钥、用户数据、未脱敏原图或私密 prompt。
>
> 2026-07-24 迁移说明：表内 `site/` 路径记录的是当时审计基线。官网已迁移到独立 `IvyYang1999/swob-website` 仓库；主应用 README 仍使用的四张截图已移至 `docs/readme-assets/`，其余旧站资产可通过 Git 历史追溯。

基线：`e02aebfa0e3f4f2a8dcde2d954d2a1a10be60b6d`（t154 开工时的 `master`）

原始清单：`compliance/t131/asset-provenance.csv`

## 填写规则

- “自有”需回答谁创作/截图、使用什么工具、大致日期，以及 Dark Constant, LLC 是否拥有 Apache-2.0 分发所需权利。
- “产品截图”还需确认只含自有 UI，且账号、会话、路径、客户信息、token 等已脱敏。
- “第三方品牌”必须给官方来源 URL、当时适用的品牌规范/条款 URL 和再分发依据；拿不到就使用 `build/icons-neutral/` 的中性替代。

## 逐项确认

| # | 文件名 | 预览路径 | 需要 yyt 回答的问题 | yyt 填写 | 最终处置 |
| ---: | --- | --- | --- | --- | --- |
| 1 | `build/icon.icns` | `../../build/icon.icns` | 谁创作/生成？原始可编辑源文件在哪？有无第三方素材？Dark Constant, LLC 是否有权以 Apache-2.0 分发？ | 由 AI 工具（Claude）辅助生成，2026-03-07 首次提交（`6cb5553`）。无第三方素材；`build/icon.png` 为原始源，`icon.icns` 由其转换。Dark Constant, LLC 拥有全部权利，可按 Apache-2.0 分发。 | 保留；t156 计划替换 |
| 2 | `build/icon.png` | `../../build/icon.png` | 是否与 `icon.icns` 同源？转换工具/日期是什么？权利是否归 Dark Constant, LLC？ | 与 `icon.icns` 同源，AI 生成，同日首次提交；转换由 electron-builder 图标管线完成。权利归 Dark Constant, LLC。 | 保留；t156 计划替换 |
| 3 | `docs/banner.png` | `../../docs/banner.png` | 是自制还是使用模板/生成器？请写工具、日期、第三方元素及分发权利。 | 由 yyt 使用 AI 工具生成，2026-03-12 首次提交（`8591614`）。无第三方模板，含自有 Swob 文字标；Dark Constant, LLC 有权分发。 | 保留；t156 计划替换 |
| 4 | `docs/screenshot.png` | `../../docs/screenshot.png` | 是否由你截取的 Swob 界面？是否只含有权展示的内容且已脱敏？截图/编辑日期和工具？ | yyt 自截的 Swob 产品界面，2026-03-12（`662eb36`），工具为 macOS 截图。界面内容为开发期合成/自有数据，已脱敏，不含真实客户信息、密钥或第三方隐私内容。 | 保留 |
| 5 | `site/assets/chat.png` | `../../site/assets/chat.png` | 是否自截的 Swob 产品图？会话、路径、账号和客户信息是否已脱敏？ | yyt 自截的 Swob 聊天视图，2026-07-20（`61bff18`）。使用合成会话数据，无真实客户内容，已脱敏。 | 保留 |
| 6 | `site/assets/favicon.svg` | `../../site/assets/favicon.svg` | 谁设计/生成？是否与 Swob 主图标同源？是否含第三方素材？ | AI 生成的 SVG 矢量图标，2026-07-21（`83e3844`），与 Swob 主图标同源设计语言，无第三方素材。 | 保留；t156 计划替换 |
| 7 | `site/assets/graph-view.png` | `../../site/assets/graph-view.png` | 是否自截的 Swob 产品图？图中会话名、路径、账号等是否全部可公开？ | yyt 自截的 Swob 会话图谱视图，2026-07-21（`83e3844`）。图中会话名为合成数据，路径为开发环境；可公开，已脱敏。 | 保留 |
| 8 | `site/assets/graph-view.webp` | `../../site/assets/graph-view.webp` | 是否仅由 `graph-view.png` 转换？请写确定性转换命令/工具版本；源 PNG 权利是否已确认？ | 由 `graph-view.png` 经 `cwebp` 转换，2026-07-21（`3c229c4`）；源 PNG 权利已按第 7 项确认。 | 保留 |
| 9 | `site/assets/insights-dashboard.png` | `../../site/assets/insights-dashboard.png` | 是否自截的 Swob 产品图？数据、项目名、token/金额等是否为可公开或模拟数据？ | yyt 自截的 Swob Insights 仪表盘，2026-07-21（`83e3844`）。数据为开发环境合成数据，项目名、token、金额均非真实用户数据，可公开。 | 保留 |
| 10 | `site/assets/insights-dashboard.webp` | `../../site/assets/insights-dashboard.webp` | 是否仅由同名 PNG 转换？请写转换命令/版本，并确认源 PNG 已 clearance。 | 由同名 PNG 经 `cwebp` 转换，2026-07-21（`3c229c4`）；源 PNG 权利已按第 9 项确认。 | 保留 |
| 11 | `site/assets/main.png` | `../../site/assets/main.png` | 是否与 `docs/screenshot.png` 同一原图？由谁复制/导出？脱敏和展示权利是否已确认？ | 与 `docs/screenshot.png` 为同期产品截图（可能同源），2026-07-20（`61bff18`），由 yyt 截取，已脱敏。 | 保留 |
| 12 | `site/assets/search.png` | `../../site/assets/search.png` | 是否自截的 Swob 产品图？搜索词、会话内容、路径等是否已脱敏？ | yyt 自截的 Swob 搜索界面，2026-07-20（`61bff18`）。搜索词和会话内容为合成数据，已脱敏。 | 保留 |
| 13 | `site/assets/session-audit.png` | `../../site/assets/session-audit.png` | 是否自截的 Swob 产品图？审计内容是否为模拟/可公开数据且已脱敏？ | yyt 自截的 Swob 审计面板，2026-07-21（`83e3844`）。审计数据为开发环境合成数据，已脱敏。 | 保留 |
| 14 | `site/assets/session-audit.webp` | `../../site/assets/session-audit.webp` | 是否仅由同名 PNG 转换？请写转换命令/版本，并确认源 PNG 已 clearance。 | 由同名 PNG 经 `cwebp` 转换（`3c229c4`）；源 PNG 权利已按第 13 项确认。 | 保留 |
| 15 | `site/assets/session-debugger.png` | `../../site/assets/session-debugger.png` | 是否自截的 Swob 产品图？调试内容、路径、ID 和日志是否已脱敏？ | yyt 自截的 Swob 执行树/调试面板，2026-07-21（`83e3844`）。调试内容、路径和 ID 均为开发环境数据，已脱敏。 | 保留 |
| 16 | `site/assets/session-debugger.webp` | `../../site/assets/session-debugger.webp` | 是否仅由同名 PNG 转换？请写转换命令/版本，并确认源 PNG 已 clearance。 | 由同名 PNG 经 `cwebp` 转换（`3c229c4`）；源 PNG 权利已按第 15 项确认。 | 保留 |
| 17 | `site/assets/sidebar.png` | `../../site/assets/sidebar.png` | 是否自截的 Swob 产品图？侧栏中项目/会话/路径名是否可公开且已脱敏？ | yyt 自截的 Swob 侧栏，2026-07-20（`61bff18`）。侧栏项目/会话名为合成数据，可公开，已脱敏。 | 保留 |
| 18 | `site/assets/social-preview.png` | `../../site/assets/social-preview.png` | 是自制还是使用模板/生成器？字体、图标、底图和品牌元素分别来自哪里？ | AI 辅助生成的社交预览图，2026-07-21（`1721176`）。由 Swob 品牌文字和产品截图合成，底图、字体均为系统默认或自有，无外部模板。 | 保留；t156 计划替换 |
| 19 | `src/renderer/src/assets/icons/claude.png` | `../../src/renderer/src/assets/icons/claude.png` | 请给官方源 URL、品牌规范/条款 URL、下载日期和允许随应用再分发的依据；拿不到是否换 `build/icons-neutral/claude-neutral.svg`？ | 2026-04-23（`c9ae574`）下载的 Anthropic Claude 品牌图标；官方品牌页为 <https://www.anthropic.com/news/press-resources>。由于随应用再分发依据未充分闭合，t140 不再分发该品牌图标。 | 中性替换（t140） |
| 20 | `src/renderer/src/assets/icons/cursor.png` | `../../src/renderer/src/assets/icons/cursor.png` | 请给官方源 URL、品牌规范/条款 URL、下载日期和再分发依据；拿不到是否换 `build/icons-neutral/cursor-neutral.svg`？ | 2026-04-23（`c9ae574`）取得的 Cursor 品牌图标，来源为 Cursor 官网/应用内。未取得可核验的随应用再分发依据，t140 不再分发该品牌图标。 | 中性替换（t140） |
| 21 | `src/renderer/src/assets/icons/openai.png` | `../../src/renderer/src/assets/icons/openai.png` | 请给官方源 URL、品牌规范/条款 URL、下载日期和再分发依据；拿不到是否换 `build/icons-neutral/openai-neutral.svg`？ | 2026-04-23（`c9ae574`）下载的 OpenAI 品牌图标；官方品牌页为 <https://openai.com/brand>。由于随应用再分发依据未充分闭合，t140 不再分发该品牌图标。 | 中性替换（t140） |

## yyt 总体确认

- [x] 上述“保留”项的填写均为真实、可追溯且不含故意遗漏。
- [x] 产品截图中不含未授权的客户/用户内容或未脱敏秘密。
- [x] 无法证明的第三方品牌图已标记为中性替换或移除。

填写人：Yuntong Yang<br>
填写日期：2026-07-23<br>
复核人/日期：____________________
