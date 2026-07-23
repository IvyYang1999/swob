<!-- provenance: author=claude harness=claude-code model=claude-fable-5·官方订阅 device=mac-mini session=6194f333-1f32-44c2-b629-91bd4a88143a -->
---
type: Show HN 卖点事实包
created: 2026-07-20
用途: 今日 Show HN 三件套（落地页/README装修/社媒文案）worker 共用素材。开发者受众口径（≠投资人企业口径）。
铁律: 只用本文核实过的事实；标「roadmap/未做」的功能禁写成已有（Show HN 最忌吹了进去没有→评论区当场拍死）。
---
# Swob · Show HN 卖点与事实包（开发者视角）

## 一句话（招牌，已定，别改）
**A git graph for your AI conversations.**
（AI 编程会话的 git graph——追踪 fork/resume 谱系、展开 compact、全平台、一键 resume、100% 本地。）

## 受众与口径
- 受众 = HN / V2EX / 即刻 上的 AI 编程重度用户（个人开发者），不是企业买家、不是投资人。
- 卖「我自己每天用、解决我自己的真痛点」的开发者工具故事，**不讲企业/审计/融资**（那是另一套）。

## 真实卖点（全部已上线，可写）
1. **会话血统检测**：resume 会生成新文件、fork 会分叉、compact 会另起——swob 精确识别这些关系（fork 边/continuation 边/多文件 resume），落盘血统注册表，缓存重建也不丢谱系。**（注意：关系"检测"已上线；可视化"树视图"是 roadmap，见下）**
2. **展开 compact 折叠**：compact 后原始消息仍在 JSONL 里，swob 内联显示每个 compact 块、一键就地展开，不用手翻 JSONL。
3. **多平台统一**：Claude Code / Codex / Cursor / OpenCode / Zcode 五家，一个界面浏览+resume（读各自的 `~/.claude/projects`、`~/.codex/sessions` 等）。
4. **全文搜索 + Spotlight 跳转**：`⌘K` 跨会话全文搜（匹配自动展开 compact 段）；`⌘⇧K` Spotlight 式模糊跳转（按内容/项目/时间/来源过滤）。
5. **一键 resume**：点任意会话在 Terminal/iTerm2 重开，保留工作目录与权限模式，支持 codex/cursor resume；批量 resume 整个文件夹；SSH 远程 resume。
6. **Token 洞察面板**：5 张统计卡 + 365 天贡献热力图 + 来源/模型分布 + 按项目 token 排名 + 30 天趋势。
7. **CLI（`swob`）**：search/list/resume/insights/active，全 JSON 输出；`swob install` 还装 Claude Code Skill，让 Claude 会话里能直接调 swob。
8. **100% 本地 + 开源**：会话不上传；v1.3.0 起采用 Apache-2.0，v1.2.0 及更早版本仍为 AGPL-3.0-only。
9. **iCloud 备份 + drag-to-export**：会话自动导出 Markdown，可拖进别的 app 带上下文；iCloud 占位文件按需下载。

## 独家钩子（Show HN 正文/标题可用，全部实测数据）
- **「官方在删你的会话，你却不知道」**：Claude Code 默认 30 天自动清理本地会话（cleanupPeriodDays）。我实测自己的 1621 个会话里 **253 个（15.6%）原件已被官方策略删除，只因 swob 做了备份才留住**。← 最强钩子，有争议性+数据+故事。
- **resume 恢复率实测**：1621 会话跨 5 平台，93.58% 可验证恢复。
- **需求佐证**：Anthropic 官方仓库有一份用户写的「会话分支/树状导航」完整需求 spec（issue #32631），官方至今没做——「你们要的 git-for-sessions，我做了个能用的」。

## 诚实边界（必须遵守，禁美化）
- ⚠️ **可视化血统树视图 = roadmap 未做**。现在做到的是"精确检测关系 + 注册表"，界面上是关系标注/多文件归并，**不是一张酷炫的树状图**。落地页/HN 标题可用「git graph」作比喻（git 的价值在 blame/history 不只在画图），但**不能展示不存在的树图截图**，正文要说清"树视图在路上"。
- ✅ **v1.3.0 已签名/公证**：Developer ID 签名、公证与 staple 由发布门禁验证。v1.2.0 用户仍需手动覆盖安装一次以迁移信任根。
- ⚠️ **仅 macOS**。
- ⚠️ 赛道拥挤（已有 claude-code-history-viewer 1886★ 等免费查看器）——**差异化一句话**：别家给你看单个会话，swob 给你看**会话之间的关系**（血统）+ **跨 5 平台** + **compact 展开**。别吹"唯一/首个多源"（不实，别家多的支持 28 源）。

## 关键链接
- 仓库：github.com/IvyYang1999/swob（public；v1.3.0 起 Apache-2.0）
- Releases：github.com/IvyYang1999/swob/releases/tag/v1.3.0（双架构签名 DMG/ZIP）
- 招牌语：A git graph for your AI conversations
- 技术栈：Electron 40 · React 19 · TS · Zustand · Tailwind 4 · Recharts
