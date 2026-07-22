# Swob 资产来源确认表（待 yyt 填写）

> 用途：关闭 t131 的 21 项视觉资产来源堵点。请逐项填写；不确定或无法证明时不要猜，直接写“无法确认”并选择移除/替换。不要在本表粘贴密钥、用户数据、未脱敏原图或私密 prompt。

基线：`e02aebfa0e3f4f2a8dcde2d954d2a1a10be60b6d`（t154 开工时的 `master`）

原始清单：`compliance/t131/asset-provenance.csv`

## 填写规则

- “自有”需回答谁创作/截图、使用什么工具、大致日期，以及 Dark Constant, LLC 是否拥有 Apache-2.0 分发所需权利。
- “产品截图”还需确认只含自有 UI，且账号、会话、路径、客户信息、token 等已脱敏。
- “第三方品牌”必须给官方来源 URL、当时适用的品牌规范/条款 URL 和再分发依据；拿不到就使用 `build/icons-neutral/` 的中性替代。

## 逐项确认

| # | 文件名 | 预览路径 | 需要 yyt 回答的问题 | yyt 填写 | 最终处置 |
| ---: | --- | --- | --- | --- | --- |
| 1 | `build/icon.icns` | `../../build/icon.icns` | 谁创作/生成？原始可编辑源文件在哪？有无第三方素材？Dark Constant, LLC 是否有权以 Apache-2.0 分发？ |  | 保留 / 替换 / 移除 |
| 2 | `build/icon.png` | `../../build/icon.png` | 是否与 `icon.icns` 同源？转换工具/日期是什么？权利是否归 Dark Constant, LLC？ |  | 保留 / 替换 / 移除 |
| 3 | `docs/banner.png` | `../../docs/banner.png` | 是自制还是使用模板/生成器？请写工具、日期、第三方元素及分发权利。 |  | 保留 / 替换 / 移除 |
| 4 | `docs/screenshot.png` | `../../docs/screenshot.png` | 是否由你截取的 Swob 界面？是否只含有权展示的内容且已脱敏？截图/编辑日期和工具？ |  | 保留 / 替换 / 移除 |
| 5 | `site/assets/chat.png` | `../../site/assets/chat.png` | 是否自截的 Swob 产品图？会话、路径、账号和客户信息是否已脱敏？ |  | 保留 / 替换 / 移除 |
| 6 | `site/assets/favicon.svg` | `../../site/assets/favicon.svg` | 谁设计/生成？是否与 Swob 主图标同源？是否含第三方素材？ |  | 保留 / 替换 / 移除 |
| 7 | `site/assets/graph-view.png` | `../../site/assets/graph-view.png` | 是否自截的 Swob 产品图？图中会话名、路径、账号等是否全部可公开？ |  | 保留 / 替换 / 移除 |
| 8 | `site/assets/graph-view.webp` | `../../site/assets/graph-view.webp` | 是否仅由 `graph-view.png` 转换？请写确定性转换命令/工具版本；源 PNG 权利是否已确认？ |  | 保留 / 重生成 / 移除 |
| 9 | `site/assets/insights-dashboard.png` | `../../site/assets/insights-dashboard.png` | 是否自截的 Swob 产品图？数据、项目名、token/金额等是否为可公开或模拟数据？ |  | 保留 / 替换 / 移除 |
| 10 | `site/assets/insights-dashboard.webp` | `../../site/assets/insights-dashboard.webp` | 是否仅由同名 PNG 转换？请写转换命令/版本，并确认源 PNG 已 clearance。 |  | 保留 / 重生成 / 移除 |
| 11 | `site/assets/main.png` | `../../site/assets/main.png` | 是否与 `docs/screenshot.png` 同一原图？由谁复制/导出？脱敏和展示权利是否已确认？ |  | 保留 / 替换 / 移除 |
| 12 | `site/assets/search.png` | `../../site/assets/search.png` | 是否自截的 Swob 产品图？搜索词、会话内容、路径等是否已脱敏？ |  | 保留 / 替换 / 移除 |
| 13 | `site/assets/session-audit.png` | `../../site/assets/session-audit.png` | 是否自截的 Swob 产品图？审计内容是否为模拟/可公开数据且已脱敏？ |  | 保留 / 替换 / 移除 |
| 14 | `site/assets/session-audit.webp` | `../../site/assets/session-audit.webp` | 是否仅由同名 PNG 转换？请写转换命令/版本，并确认源 PNG 已 clearance。 |  | 保留 / 重生成 / 移除 |
| 15 | `site/assets/session-debugger.png` | `../../site/assets/session-debugger.png` | 是否自截的 Swob 产品图？调试内容、路径、ID 和日志是否已脱敏？ |  | 保留 / 替换 / 移除 |
| 16 | `site/assets/session-debugger.webp` | `../../site/assets/session-debugger.webp` | 是否仅由同名 PNG 转换？请写转换命令/版本，并确认源 PNG 已 clearance。 |  | 保留 / 重生成 / 移除 |
| 17 | `site/assets/sidebar.png` | `../../site/assets/sidebar.png` | 是否自截的 Swob 产品图？侧栏中项目/会话/路径名是否可公开且已脱敏？ |  | 保留 / 替换 / 移除 |
| 18 | `site/assets/social-preview.png` | `../../site/assets/social-preview.png` | 是自制还是使用模板/生成器？字体、图标、底图和品牌元素分别来自哪里？ |  | 保留 / 替换 / 移除 |
| 19 | `src/renderer/src/assets/icons/claude.png` | `../../src/renderer/src/assets/icons/claude.png` | 请给官方源 URL、品牌规范/条款 URL、下载日期和允许随应用再分发的依据；拿不到是否换 `build/icons-neutral/claude-neutral.svg`？ |  | 保留 / 中性替换 / 移除 |
| 20 | `src/renderer/src/assets/icons/cursor.png` | `../../src/renderer/src/assets/icons/cursor.png` | 请给官方源 URL、品牌规范/条款 URL、下载日期和再分发依据；拿不到是否换 `build/icons-neutral/cursor-neutral.svg`？ |  | 保留 / 中性替换 / 移除 |
| 21 | `src/renderer/src/assets/icons/openai.png` | `../../src/renderer/src/assets/icons/openai.png` | 请给官方源 URL、品牌规范/条款 URL、下载日期和再分发依据；拿不到是否换 `build/icons-neutral/openai-neutral.svg`？ |  | 保留 / 中性替换 / 移除 |

## yyt 总体确认

- [ ] 上述“保留”项的填写均为真实、可追溯且不含故意遗漏。
- [ ] 产品截图中不含未授权的客户/用户内容或未脱敏秘密。
- [ ] 无法证明的第三方品牌图已标记为中性替换或移除。

填写人：____________________<br>
填写日期：____________________<br>
复核人/日期：____________________
