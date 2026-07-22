# Swob 官网、README、文档站整体验收与上线准备

日期：2026-07-23  
验收分支：audit/tw5-launch-readiness  
范围：README 三语、当前官网 site、Website V2 WIP、文档站 site/docs、域名与部署预案  
红线执行：未部署、未购买域名、未修改 DNS

## 1. 决策结论

### 1.1 发布结论

| 对象 | 结论 | 为什么 |
|---|---|---|
| 当前线上站 https://ivyyang1999.github.io/swob/ | NO-GO | 2026-07-23 实测仍在展示“11 个来源完整历史”、固定 v1.2.0 资产 URL 和 next release 承诺。修复尚未部署。 |
| 本分支的 README 三语 + 当前 site + docs | 有条件 GO | 能力口径、下载真相源、死链、390px、SEO 元数据和对比度门禁均已闭合；仍要等 t156 新 logo，并由 yyt 决定合并与发布。 |
| Website V2 WIP 96fb022 | NO-GO | 有六类事实越界、伪英文路由、移动端溢出、移动 demo 未降级、Hero 占位、Lighthouse 性能 74。 |
| Apache-2.0 对外表述 | BLOCKED | 当前根 LICENSE 与 package.json 都是 AGPL-3.0-only；t131 仍为 NO-GO，权利链与资产来源表仍待 yyt 签/填，t140 尚不存在可合并分支。 |

最短可靠路径不是等 V2：先合并本验收分支，等 t156 后发布当前静态站；V2 作为下一轮重构，在 Preview 环境完成事实与 UI 一致性验收后再切换。

### 1.2 域名与托管建议

- 首选域名：swob.app。它是品牌精确匹配，也不会像 swob.dev 一样把 Swob 锁成开发者工具。
- 可选防御域名：getswob.com。更容易口述和跨圈层，但品牌纯度低于 swob.app。
- 不建议主域：swob.dev。价格略低，但与“所有 AI 对话的家、非开发者专属”的定位冲突。
- 近期托管：继续 GitHub Pages。当前 site 已有稳定的 Pages Actions 工作流，迁移当前纯静态站不会产生用户价值。
- V2：接入 Vercel Preview 做每分支预览；只有在 V2 产物能同时包含 /docs、双语真实路由和发布门禁后，才评估把生产域名切到 Vercel。

## 2. 验收方法与真相源

两把尺子：

1. 能力真相：src/shared/provider-capabilities.ts。
2. 口径字典：site/docs 生成页及其源脚本 scripts/generate-docs.mjs。

执行过的核验：

- 逐页 crawl 26 个 HTML、3 个 README。
- 对 README、site、V2 文案逐条对照 provider capability registry。
- 真实浏览器检查桌面与 390×844：纵向滚动、导航、语言切换、FAQ 展开、hover、demo 输入/切换、移动菜单。
- 用合成隔离数据启动产品并截图侧栏、Insights 和全局对话，和官网素材及 V2 demo 并排比对。
- 运行 linkinator、Lighthouse、Website V2 build、产品 E2E。
- 查询注册局 RDAP、Vercel 与 GitHub 官方域名文档、当前非 premium TLD 价格。

浏览器证据均为公开页或合成数据，没有真实用户会话。

## 3. 能力口径结论

provider registry 的唯一可验证总口径是 5+1+5：

| 层级 | 来源 | 边界 |
|---|---|---|
| 原生格式适配器 5 | Claude Code、Codex、Cursor、OpenCode、ZCode | transcript 可读，但 search、usage、lineage、watch、archive、resume 逐来源不同。 |
| 兼容格式 1 | CC-Mirror | Claude 兼容 transcript/search/usage 可用；watch/archive 不可用；terminal resume 实验性。 |
| 仅检测 5 | Antigravity、Grok/Factory、Pi、Kimi Code、Hermes | 只能发现文件和显示元数据占位；不能读取、索引或审计消息正文。 |

行号证据：

- 来源清单与 tier 定义：src/shared/provider-capabilities.ts:9、:24。
- detection-only 明确无 transcript/search/usage/archive：同文件 :114-143。
- 5 个原生定义：同文件 :170-237。
- 兼容来源及能力：同文件 :239-262。
- 5 个 detection-only 定义：同文件 :264-268。

README 当前已准确解释“原生适配器不等于全能力”：README.md:51、:78-106；中文与日文 README 同步。

## 4. 问题清单

### P0：发布阻断

| ID | 问题 | 证据 | 状态 |
|---|---|---|---|
| TW5-01 | 线上旧站仍把 11 个来源写成可搜索历史，并直链固定 v1.2.0 DMG。 | 2026-07-23 curl 线上 HTML：meta :7/:20，Hero :76，来源 :104/:205，下载 :65/:78/:340。旧站截图见下。 | 已在 0e762a5 修复并合入本分支 dcd6f3d；未部署。 |
| TW5-02 | V2 把大多数工具 30 天、ChatGPT 导入、无条件复活、真实花费、所有数据只在本地写成当前能力。 | Website V2 i18n.ts:65-76、:106-108、:139-150、:180-182。 | 未修；禁止合入。 |
| TW5-03 | V2 重新使用浮动 releases/latest，并把 v1.2.0 当永久 fallback。 | Website V2 Footer.tsx:3-29；index.html:41。 | 未修；必须 fail closed 到 Releases 列表或可验证 manifest。 |
| TW5-04 | tW5 背景假定“t140 后应为 Apache”，但 t140 实际未落地。 | 当前 LICENSE:1 为 GNU AGPL；package.json:5 为 AGPL-3.0-only；t131 REPORT 仍 NO-GO，两个 yyt 表单仍是待签/待填。 | 当前公开 AGPL 表述正确；Apache 文案必须等待 t140 原子切换。 |

旧站失实口径：

![旧站 11 来源与固定下载口径](assets/tw5-2026-07-23/current-site-home-desktop-annotated.png)

本分支止血后：

![当前站最终桌面验收](assets/tw5-2026-07-23/current-site-final-desktop.png)

### P1：V2 与产品一致性阻断

| ID | 问题 | 证据 | 状态 |
|---|---|---|---|
| TW5-05 | V2 声明 /en/，但构建产物只有单个 SPA 入口；静态服务器访问 /en/ 为 404。 | index.html:13，i18n.ts:219；linkinator 实测 404。 | 未修。建议保持现有 URL：/ 为英文、/zh/ 为中文，做真实静态入口。 |
| TW5-06 | V2 构建只有 website/dist，导航用 ../docs/；若单独部署 dist，文档不会进入产物。 | Navbar.tsx:14、Footer.tsx:42；Vite config 只输出 dist。 | 未修。发布工作流必须组装 V2 + site/docs + 公共 assets。 |
| TW5-07 | 390px 下 V2 文档宽度 397px，超出视口 7px；Collect demo 的侧栏 min-width 180 是直接风险。 | 实测 innerWidth 390 / documentElement.scrollWidth 397；CollectDemo.tsx:146；移动截图见下。 | 未修。body overflow-x:hidden 只是隐藏问题。 |
| TW5-08 | tW2 要求移动端降级截图/静态帧，WIP 仍加载四个 React 交互 demo。 | CapabilitySection.tsx:4-7、:43-46；global.css:242-273 只有改布局，没有静态替代。 | 未修。 |
| TW5-09 | V2 Hero 仍是 Product Screenshot 空框。 | Hero.tsx:21-23、:41。 | 未修。 |
| TW5-10 | V2 demo 是营销仿真，不和当前产品完全一致。 | 见第 5 节逐组件对照。 | 未修；不可宣称“真实产品界面”。 |
| TW5-11 | V2 未达到 tW3 性能门槛。 | 本地 production build Lighthouse desktop：Performance 74、Accessibility 95、Best Practices 100、SEO 100；LCP 2.6s；另有 color contrast failure。 | 未修。 |
| TW5-12 | 当前官网截图落后于产品新 UI。 | 主要截图最后提交在 2026-07-20/21；当前产品侧栏、Insights、全局对话已有后续布局。 | 未修。重拍必须等当前产品 UI 批稳定。 |

V2 桌面与交互：

![Website V2 桌面](assets/tw5-2026-07-23/website-v2-desktop-annotated.png)

![Website V2 交互 demo](assets/tw5-2026-07-23/website-v2-demo-interactions.png)

V2 移动端：

![Website V2 390px 溢出证据](assets/tw5-2026-07-23/website-v2-mobile-annotated.png)

### P2：发布质量与治理

| ID | 问题 | 证据 | 状态 |
|---|---|---|---|
| TW5-13 | 当前站仍以 DeveloperApplication、AI coding debugger 为核心，和“所有 AI 对话的家”存在定位差。 | site/index.html:33-40；当前 Hero :75-76。 | 非事实错误，可由 V2 解决；不阻断止血发布。 |
| TW5-14 | 英文 docs 是保留路由而非翻译，之前会被索引。 | site/docs/en 各页 description 为 Reserved English documentation route。 | 已为 12 个占位页增加 noindex, follow；不再污染搜索结果。 |
| TW5-15 | sitemap 之前只列首页、中文首页、docs 首页与 metrics，漏 10 个中文文档页。 | 旧 sitemap 共 4 个 loc。 | 已补全全部 14 个可索引路由，并加入自动门禁。 |
| TW5-16 | 旧 favicon/logo 尚未换成 t156 品牌资产。 | 当前 site/assets/favicon.svg；t156 仅在 chore/t156-logo-pipeline@5f48945。 | 等 t156 验收合并后再发布。 |
| TW5-17 | t126 是脏工作树中的孤儿官网实现，会和 V2 形成第三套事实与视觉。 | feature/t126-website-redesign@78cbb81，site.css/site.js/index/zh 四个未提交修改。 | 建议冻结、不合并、不删除，直到 V2 路线确认后归档。 |
| TW5-18 | 当前产品站有 5 个临界对比度问题。 | 首轮 Lighthouse Accessibility 95；失败节点为 kicker、两个 code、stable channel tag、final eyebrow。 | 已按组件修复；最终 Accessibility 100，视觉回看通过。 |

## 5. 动态 UI 与实际产品的一致性

结论：四个 demo 都有真实交互，但没有一个可以称为“与当前产品完全一致”。这不是 React 技术问题，而是两套 UI 独立演进导致的事实和视觉漂移。

| Demo | 已做到 | 与当前产品差距 | 发布处理 |
|---|---|---|---|
| 珍藏 / Collect | 可展开分组、切镜头、读会话。 | 使用旧侧栏结构；当前产品已有“整理会话/查看全部会话”切换和新的分组 IA；移动侧栏有固定最小宽度。 | 用当前产品 E2E 合成截图作视觉基线，重做桌面仿真；移动用静态帧。 |
| 找回 / Recover | 输入过滤、点击 revive 状态动画。 | 文案把所有来源写成完整备份和一键恢复；真实能力要按来源、证据和冲突检查。 | demo 只演示被验证的 Claude Code 路径，并显示来源与限制。 |
| 看清 / Insight | 有 token/API 等价值卡和排名。 | 当前 Insights 有多 tab、范围/来源筛选、unavailable 状态与更多口径；WIP 简化过度。 | fixture 保留 reported/estimated/unavailable 和订阅/本地模型边界。 |
| 随身 / Companion | 有预置对话回放。 | 与当前全局对话窗的信息结构和控件不一致；搜索所有历史仍被写成绝对承诺。 | 用产品当前 global chat 截图重建；明确演示数据与实际索引范围。 |

当前产品合成基线：

![当前产品侧栏合成基线](assets/tw5-2026-07-23/product-current-sidebar-synthetic.png)

![当前产品 Insights 合成基线](assets/tw5-2026-07-23/product-current-insights-synthetic.png)

![当前产品全局对话合成基线](assets/tw5-2026-07-23/product-current-chat-synthetic.png)

实现策略：

- 本轮不需要修改 Swob renderer。先按 tW2 的边界在 website 内做仿真，避免把 Electron、IPC 和桌面依赖带进官网。
- 为降低再次漂移，官网 fixture 和语义 token 应有明确 schema；每次产品 UI 变更用合成 E2E 截图做并排验收。
- 第二阶段可以共享纯展示 token、类型与 fixture schema，但不要直接 import src/renderer。

## 6. 当前信息架构审查

### 当前 site

优点：

- 证据先于口号；来源矩阵、隐私边界、stable vs current main 区分清楚。
- 文档与官网相互可达，移动端和无 JS 场景稳。
- 静态体积小，发布风险低。

问题：

- 叙事从“图谱/调试器/AI coding harness”出发，普通写作者和研究者难以先看到自己的问题。
- 大量技术能力在首页同级展开，缺少“珍藏—找回—看清—随身”的生活化任务层。
- 截图比文案更容易过期，没有素材 freshness 门禁。

### Website V2

方向是对的：Hero → 痛点 → 四能力 → 信任 → 人群 → FAQ → 下载，明显更符合 Notion/Obsidian 式产品叙事。

推荐最终路由与产物：

- /：英文主页，保留当前已索引 canonical。
- /zh/：中文主页。
- /docs/：现有中文文档。
- /docs/en/：只有完成翻译后再 index；占位期 noindex。
- 一个组装发布产物必须同时包含 V2 dist、site/docs、social preview、favicon、robots 和 sitemap。

## 7. V2 续做路线

不要把当前 WIP 当成完成的 tW1 后直接派 tW2。它已经混入四个 demo 和内容，旧任务边界失效。建议重新定义三个可验收批次：

| 批次 | 时间估算 | 交付 |
|---|---:|---|
| tW1-r2：事实与发布契约 | 3-5 天 | rebase WIP；关闭所有 tW3 红线；真实双语路由；修复 base path/docs artifact/download truth；删除 Hero 空框；390px 0 overflow；补门禁测试。 |
| tW2-r2：四 demo 产品一致性 | 4-7 天 | 以当前 E2E 合成截图为基线重做四 demo；desktop 可交互；mobile 静态；fixture schema；lazy load；逐 demo 事实标签。 |
| tW3-r2：内容与发布预备 | 3-5 天 | 完成双语、OG、sitemap、t156 品牌资产、Lighthouse 四项 ≥90、死链 0、完整截图包和 Preview 验收。 |
| 最终回归 | 2 天 | 产品事实抽查、桌面/390、键盘、滚动、hover、部署产物与回滚演练。 |

总量约 12-19 个工作日，单人连续投入才有机会卡在三周附近，不能作为近期域名上线的前置条件。因此当前 site 止血版是必要的，而不是重复工作。

## 8. tW0 收口

原 WIP fix/tw0-source-capability-copy@e4e4d31 已补完并重放到当前 master 基线：

- 最终提交：0e762a5 fix: align public capability claims with provider registry。
- 验收合并：dcd6f3d merge: close tW0 public capability truth gaps。
- README 英/中/日与 site 英/中均改为 5+1+5 和逐来源能力边界。
- 删除直接版本资产 URL，CTA 统一进入 GitHub Releases 真相页。
- 不再保证“next release”；current main 与 public installer 明确分开。
- 新增 scripts/check-public-copy.mjs，从 provider registry 自动导出 tier 数量，并拦截六类 tW3 禁词/绝对承诺。

## 9. 本轮新增发布门禁

新增 scripts/check-public-links.mjs，并接入 npm run check：

- 校验 site 内所有 href、src、srcset 与跨页锚点。
- 校验 3 个 README 的本地链接与图片。
- 校验每页 title、description、viewport、favicon。
- 校验首页 canonical、OG、Twitter。
- 校验 robots 对 sitemap 的引用。
- 校验 sitemap 覆盖全部可索引 HTML，且路由有实际产物。
- 校验英文占位文档必须 noindex。

最终结果：

- public-copy：11 providers，5+1+5，5 个公开文案入口，AGPL-3.0-only，通过。
- public-links：26 HTML、3 README、完整 sitemap，通过。
- linkinator：跳过 GNU AGPL 页的自动化 403 假阳性后，37 个链接，0 错误。
- docs:check：25 个生成物，通过。
- 当前 site Lighthouse desktop：Performance 94、Accessibility 100、Best Practices 100、SEO 100；LCP 1.5s、CLS 0。
- Website V2 build：48 modules，主 JS 220.22 kB，gzip 70.22 kB，通过；但 Lighthouse Performance 74，不满足发布门槛。
- 产品构建：通过。
- 产品 E2E：app launch 两项通过；dashboard smoke 一项通过；数据使用隔离合成 HOME。

390px 最终页宽：

![当前站 390px 最终验收](assets/tw5-2026-07-23/current-site-final-mobile.png)

FAQ 展开：

![当前站移动 FAQ 展开](assets/tw5-2026-07-23/current-site-final-mobile-faq.png)

## 10. 域名可注册性与价格

查询时间：2026-07-23。注册局 RDAP 返回 404 的含义是“没有当前注册对象”，可视为高可信的未注册信号；它不保证注册商结算时不是保留词或 premium，最终状态与价格必须由 yyt 在购买页确认。

| 候选 | 权威 RDAP | 当前判断 | 非 premium 价格参照 | 品牌判断 |
|---|---|---|---|---|
| swob.app | Google Registry RDAP 404 | 很可能可注册 | 首年 $8.75；续费 $14.93 | 首选，产品化、精确、非开发者专属。 |
| swob.dev | Google Registry RDAP 404 | 很可能可注册 | 首年 $8.75；续费 $12.87 | 不建议主域，强化开发者定位。 |
| getswob.com | Verisign RDAP 404 | 很可能可注册 | 注册/续费约 $11.08 | 次选或防御域，跨人群自然但更长。 |

价格来自 Porkbun 2026-07-23 官方非 premium TLD 表，仅作横向参照；Vercel 官方说明域名按 registrar cost 出售，但公开搜索把自动化浏览器识别为 bot，未取得这三个精确名称的 Vercel checkout 报价。不要把上述价格当成 Vercel 报价。

官方资料：

- [Vercel 域名购买与管理](https://vercel.com/docs/domains/working-with-domains)
- [Vercel 域名 at-cost 说明](https://vercel.com/changelog/vercel-domains-at-cost-pricing-and-the-fastest-on-the-web)
- [Vercel 支持的 TLD](https://vercel.com/docs/domains/supported-domains)
- [Porkbun 当前 TLD 价格表](https://porkbun.com/products/domains)
- [swob.app 注册局 RDAP](https://pubapi.registry.google/rdap/domain/swob.app)
- [swob.dev 注册局 RDAP](https://pubapi.registry.google/rdap/domain/swob.dev)
- [getswob.com 注册局 RDAP](https://rdap.verisign.com/com/v1/domain/getswob.com)

## 11. 部署方案

| 维度 | GitHub Pages 当前方案 | Vercel |
|---|---|---|
| 当前状态 | 已有 .github/workflows/pages.yml，master 的 site 变更自动发布。 | 尚无项目配置。 |
| 当前 site | 零构建、零迁移、风险最低。 | 能托管，但迁移没有功能收益。 |
| V2 Preview | 需要额外 Actions 或分支 Pages。 | 每 PR/分支 Preview 是明显优势。 |
| V2 生产 | 可由 Actions 组装产物后上传。 | Vite 原生，但仍需解决 docs 组装、路由与 base path。 |
| 域名 | 支持 apex + www、自动 HTTPS。 | 域名和部署可同一控制台管理。 |
| 推荐 | 当前生产继续使用。 | 现在只接 Preview；V2 验收后再决定生产切换。 |

### yyt 十步内上线清单：Vercel 买域名，GitHub Pages 托管

1. 在 Vercel Domains 搜索 swob.app，确认 Available、非 premium、首年与续费价后由 yyt 购买；开启 2FA、自动续费和 WHOIS privacy。
2. 等本分支与 t156 合入 master、Pages 工作流成功；先验证 https://ivyyang1999.github.io/swob/ 已不再包含旧“11 harness”文案。
3. 在 GitHub 账号 Settings → Pages 验证 swob.app 所有权，按界面在 Vercel DNS 添加 TXT；等 Verified。
4. 在仓库 Settings → Pages 先填写 Custom domain 为 swob.app 并保存；必须先做这步，再改业务 DNS，避免域名接管窗口。
5. 在 Vercel DNS 为 apex 添加 4 条 A：185.199.108.153、185.199.109.153、185.199.110.153、185.199.111.153；不要添加 wildcard。
6. 添加 www CNAME 到 IvyYang1999.github.io，不带 /swob；让 GitHub Pages 自动把 www 与 apex 互相重定向。
7. 用 dig 检查 apex A 与 www CNAME；DNS 最长可能传播 24 小时。
8. GitHub Pages 证书就绪后开启 Enforce HTTPS；检查 http 到 https、www 到 canonical 的 301/308。
9. 把 site 的 canonical、OG URL、social image、robots、sitemap 和自动检查基准从 github.io/swob 更新为 swob.app，重新发布。
10. 桌面与 390px 全链路验收：首页、中文、docs、Releases、OG 抓取、404；保留 github.io URL 作为回滚入口。

GitHub 官方记录与 HTTPS 步骤：[Managing a custom domain for GitHub Pages](https://docs.github.com/en/pages/configuring-a-custom-domain-for-your-github-pages-site/managing-a-custom-domain-for-your-github-pages-site)。

### V2 未来切到 Vercel 的 7 步

1. Vercel Import Git Repository，只建立 Preview，不绑定生产域名。
2. V2 修复后把 Root Directory 指向 website，Build Command 为 npm run build，Output Directory 为 dist。
3. 发布 workflow 先把 site/docs、品牌 assets、robots、sitemap 复制进 dist；没有这一步不得切流。
4. Preview 运行 public-copy、public-links、Lighthouse、390px 和四 demo E2E。
5. 在 Vercel 项目添加 swob.app，按界面验证 DNS；保留 Pages 到最后一刻。
6. 低 TTL 后切 DNS，检查证书、apex/www、canonical、/zh/、/docs/ 和回滚。
7. 24-48 小时稳定后再移除 Pages custom domain；域名注册与代码部署权限保持分离。

## 12. 上线检查单

| 检查项 | 当前分支 | Website V2 WIP |
|---|---|---|
| 能力口径与 registry 一致 | PASS | FAIL |
| 许可与根 LICENSE 一致 | PASS，AGPL | PASS，AGPL；不得提前 Apache |
| 死链 0 | PASS | FAIL，/en/ 404；docs 产物未组装 |
| 390px 无破版 | PASS，390/390 | FAIL，397/390 |
| 移动交互 | PASS，导航/FAQ/hover/滚动已查 | FAIL，demo 未按任务降级 |
| OG/Twitter | PASS | 元数据存在但绝对承诺失实 |
| sitemap | PASS，覆盖 14 个 indexable route | 缺 V2 发布版 sitemap |
| favicon/logo | WAIT t156 | WAIT t156 |
| Lighthouse desktop | 94/100/100/100 | 74/95/100/100 |
| 下载真相源 | PASS，Releases 列表 | FAIL，latest + 固定 fallback |
| 产品 UI 一致性 | 截图过期，需重拍 | 四 demo 均未完全一致 |
| 当前线上已更新 | FAIL，未部署 | 不适用 |

最终上线门：

1. yyt 决定是否合并 dcd6f3d 之后的 tW5 变更。
2. t156 新 logo 合入并替换 favicon/social preview。
3. Pages 发布后重新跑线上 public links、Lighthouse 和文案探针。
4. 若买域名，先按第 11 节验证域名再改 DNS。
5. Apache-2.0 与本次官网上线解耦；在 t140 完成前，全站保持 AGPL-3.0-only。

## 13. 量化审查

分数只用于排序风险，不替代发布门禁。

| 维度 | 当前站候选 | Website V2 WIP |
|---|---:|---:|
| 视觉层级与精致度 | 18/20 | 16/20 |
| 设计系统一致性 | 17/20 | 15/20 |
| 可访问性 | 20/20 | 15/20 |
| 响应式与交互韧性 | 18/20 | 7/20 |
| 事实、路由与发布完整性 | 16/20 | 9/20 |
| 合计 | 89/100 | 62/100 |

当前站最大的剩余问题不是 CSS，而是线上尚未部署、截图 freshness 和旧 logo。V2 最大的问题不是视觉，而是把定位愿景写成了已实现能力；必须先修事实契约，再继续做精致度。
