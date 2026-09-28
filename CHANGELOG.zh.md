# 更新日志

[English](CHANGELOG.md)

## Unreleased

### 新功能

- **`swob doctor checkup`：只读内核体检报告**：把 Swob 内核读到的会话与原始数据的独立清点逐项对拍，写出老板看得懂的 Markdown 报告和同名 JSON（`--report <目录>` 写 `Swob内核体检-日期-机器标签.md/.json` 与 `最新-机器标签.md`，stdout 为一行摘要）。内核在隔离的子进程里、以一次性的 HOME 运行；运行前后对 Swob 状态目录、库的 `.swob` 与各来源数据库做元数据审计，必须零变化；报告要过隐私白名单扫描；同一台机器的上一份报告会自动拿来比对。本命令新增退出码：4 满足 `--fail-on`、5 只读或隔离保证不成立、6 Swob app 正在运行、7 隐私扫描拒绝。暂不支持 Windows。
- **`swob doctor locks --recover`：在 CLI 里恢复卡住的 Library 写锁**：`swob doctor locks` 以前能报出 `manualRecoveryAvailable: true`，却没有任何入口能执行恢复。现在 `swob doctor locks --recover --evidence <hash> --confirm RECOVER_LIBRARY_WRITER_LOCK` 可以：hash 必须是 `doctor locks --json` 对当前这把锁给出的 `evidenceHash`，三个参数缺一即拒绝；本机存活的 Swob 进程持有的锁永远不抢；锁整体移入 Library 的 `.swob/locks/writer-recovery-evidence/`，不删除。stdout 为 `{ recovered, reason, quarantinePath? }`；没有恢复时退出码 1，`reason` 写明原因（`evidence-changed`、`unlocked`、`active-owner` 等）。不带这些参数的 `swob doctor locks` 不变。

### 修复

- **`swob doctor checkup` 的 ④ 血统与分支不再显示「本版未实现」，改为真实判定**：Codex 派生边（自己的 `thread_spawn_edges` 表）与顶层分叉边（`session_meta.forked_from_id`）对拍 Swob 运行期已表达的状态（`branchParentId`/`branchChildIds`/`subagents[]`）；Claude Code 只有物理证据可用，同样给出「已表达 / 未表达 / Swob 多出」三栏：续写（文件内容里出现了另一个主文件的 sessionId）、子 agent 归属（与①同一套目录/编号证据）、跨文件 uuid 前缀重叠 ≥8（新文件开头原样复制了旧文件至少 8 条消息，即恢复或分叉，标 [E]）。结论：Codex 有任何一条边未表达就不通过（派生边留 1% 容差）；Claude 的物理证据缺口只算观察（最多注意，不判不通过），因为没有第一方记录可以对着判错。「和上次比」现在也会点名哪一项检查从「未实现」变成了真实判定，避免被误读成新增问题。自检新增第七类故障样本（一条 Swob 挂不上的孙级子 agent 派生边）。
- **`swob resume-audit` 找不到会话的命令行工具时也检查恢复内容**：会话对应的工具（`claude`、`codex`、`cursor`、`opencode`、`zcode`）在 PATH 上找不到时，审计原来记为 env-missing 后就跳过内容检查（L3），所以工具没装或链接失效的机器上，这些会话根本没有 L3 结论。现在照样检查，一次审计可能因此变慢：会话仍记为 env-missing（先装好或重新链接工具），L3 结论计入 `l3`（`l3.match`、`l3.mismatch`、`l3.would404` 可能变多，`l3.skipped` 相应变少），也计入新增的 `envMissingWithL3`（`match`、`mismatch`、`would404`、`skipped`；`--json` 顶层与逐来源都有）；文本报告多一行这个分布。`ok`、`fail`、`successRate`、`verifiedRate`、`l1`、`l2` 不变：找不到工具的会话永远不算已验证。没有字段改名或删除。
- **启动被 Library 写锁挡住时，不再误报「重复包修复未能安全回滚」**：启动检查拿不到 Library 写锁时（例如崩溃进程留下、本机又已无法证明是自己的锁），Swob 原来一律提示上次重复包修复未能安全回滚、请联系支持人员，然后退出，其实根本没有修复在进行；一台真实机器自 2026-09-07 起每次启动都停在这里。现在启动会说明真实原因：持锁进程、租约何时到期、是否本机这份安装，并提供【恢复锁】（把锁移入 `writer-recovery-evidence` 后继续启动）或【退出】，默认按钮是退出；锁由本机存活的 Swob 进程持有时只提供重试。重复包修复的提示只在那次回滚本身失败时出现，其它启动错误显示通用提示和错误码。
- **本机身份文件丢失后，本机留下的旧锁仍认作本机**：Swob 用存放在 `/Users/Shared/Swob/` 的本机身份证明 Library 写锁属于本机。这个文件夹被清理或重装删掉后会生成新身份，本机留下的所有锁从此都被当成其它设备的。现在 Swob 在 `~/.claude-session-manager/` 另存一份只有在本机才能校验通过的副本，原件缺失时用它恢复同一个身份；桌面端会把恢复或重新生成记进 lifecycle.log。仍然无法这样证明的锁——属于本机这份安装、租约已过期超过 24 小时、持锁进程已不存在——现在会自动恢复，原因码 `stale-by-device-and-lease` 随锁留在恢复证据里。
- **打包 CLI 契约测试不再重新生成真实宿主身份**：`NODE_ENV=production` 下，主副本路径解析会忽略测试框架早已一并设置好的沙箱标记，所以对一台还没有真实身份的机器跑打包 CLI 的写命令，会在真实的 `/Users/Shared/Swob/` 新建一份——这正是 2026-09-26 22:22 发生的事，与当时一次打包 CLI 测试跑写命令的分钟完全吻合。现在只要测试框架同时设置了 `SWOB_E2E_RUNNER` 与 `SWOB_E2E_SANDBOX_ROOT` 这两个标记，主副本与备用副本路径都会重定向进测试框架自己的沙箱，且不论 `NODE_ENV` 是什么；两个标记都不存在的普通运行不受影响。已知缺口：以 `NODE_ENV=development` 启动的开发态 e2e 桌面端还没有设置这两个标记，仍可能在跑测试的机器上新建真实身份。
- **主副本在别处被重新生成后，旧身份不再直接丢失**：备用副本原来只保存「当前」这一份身份，如果别的东西（上面这个 bug 本身、旧版构建、读不到机器标识的那一刻）在本机不知情的情况下重新生成了主副本，下一次写入就会把备用副本也覆盖成新身份，而旧身份——可能仍在为本机的锁签名——就永久丢失了。现在每一份被替换掉的旧身份都会记进 `~/.claude-session-manager/host-identity-history.jsonl`（最多保留 20 条，超出后先丢最旧的；每条历史记录都像备用副本一样做机器绑定，整个目录被复制到别的机器也无法冒领）；写锁的宿主证明如果匹配历史里的某一条身份，会自动恢复，原因码 `stale-by-identity-history`，且比证据更弱的 `stale-by-device-and-lease` 优先尝试它。
- **`swob doctor locks --recover` 的三种只读拒绝（`unlocked`、`evidence-changed`、本机存活 owner）不再触碰机器身份**：一个被拒绝的恢复请求，即使命令本身报告「没有恢复任何东西」，也可能因为只读预检内部仍然进入了写路径，而把本机的宿主身份、机器本地备用副本和 `.swob-machine` 当作副作用创建出来；现在换上正确参数重试之前，可以确定这次拒绝没有在本机留下任何新状态。`doctor locks --json` 也新增了 `deviceIdCaveat`：只有当一把 `remote-owner` 锁的持有安装 `deviceId` 与本机相同时才会出现的一行残余风险提示——这正是自动恢复或身份历史恢复有可能把「`deviceId` 恰好相同的另一台机器」误判为本机旧锁的那种场景。
- **为上一条留下的「开发态 e2e 宿主身份缺口」加了一道只读安全网**：本想照打包 CLI 那条路的办法关闭这个缺口（给危险的开发态 e2e 桌面启动也设上 `SWOB_E2E_RUNNER`/`SWOB_E2E_SANDBOX_ROOT`），实测下来发现不是加两个环境变量就能解决——`e2e-library-isolation.ts` 自己的测试契约守卫只要看到其中任一个标记存在就会强制 `dangerousRealLibrary: false`，这会让那个启动器的 e2e 用例本来要断言的「DEV · REAL LIBRARY」红色标识悄悄失效。要真正关闭这个缺口，需要改 `e2e-library-isolation.ts` 或 `host-identity.ts` 本身。在此之前，该用例在启动前后对两个真实宿主身份路径做只读 lstat 签名比对（mode/size/mtime/ino），任何一处变化都会让用例失败——与 `packaged-contract.test.ts` 给打包 CLI 路径用的是同一种检测方式。
- **`swob insights` 的 token 标签改为名副其实（对 JSON 消费方不兼容，数值不变）**：insights 的 token 汇总原来标为 `input_plus_output`，但数值一直是计费口径：非缓存输入 + 缓存读 + 缓存写 + 输出。现在标签改为 `billing_total`，涉及 `totalTokensMetric`（`--summary` 与完整 `--json` 输出都有），以及 summary 里 `bySource`、`byModel`、`topProjects` 各行的 `tokenMetric`。所有数值与之前完全相同，只是标签字符串变了；按 `input_plus_output` 匹配 insights 输出的消费方需改认 `billing_total`。`swob list` 与 `swob search` 的 `tokenMetric` 仍是 `input_plus_output`（非缓存输入 + 输出，不含缓存），它们本来就标对了。已安装的 /swob Skill 要重新运行 `swob install` 才会换成新说明。
- **分叉的 Codex 子 agent 不再顶掉父会话的估价**：分叉子 agent 会抄写父会话的 token 用量，`swob insights` 与会话审计原来估的是这份副本（常常没有 model，于是未定价；或按子 agent 的 model 计价），而不是父会话自己的那次调用。现在估价与 token 合计用同一种方式为每个计费事实选定调用，主线程的调用胜过副本（Insights 页本来就是主线程优先）。token 合计不变。
- **`swob doctor checkup` 不再把体检自己的推断错误报成内核问题**：② 对 Codex 改用内核逐文件实测的读入数比对（原先把含 U+2028/U+2029 的记录推断为丢失，而读行器修好后内核早已不丢），拿不到读数的文件不再推算、单独列出；③ 同一场 Codex 会话有多份副本、Swob 计数等于其中一份时归为「已解释」（注意，不再判不通过），逐场计数按内核的逐文件规则；`--sources` 只体检部分来源时，报告头、摘要行和盘点都会写明，`--report … --json` 的概要多一个 `sourcesSelected`，文件名是规范报告名（`Swob内核体检-日期-机器标签.md`、`最新-机器标签.md`）的 `--report` 目标会被拒绝。体检程序版本升到 1.2.0。
- **`swob doctor checkup` 只说测到的事**：`--sources` 的摘要行改为「所选来源 N 场会话」，不再写「全部」；某来源整源没有读数时，② 的一句话和摘要行都点名该来源（「本轮未取得读数」），不再说记录读全；业主版说明文字改写，例如含特殊行分隔符的记录改为「Swob 这次读到的比原始记录少」。判定与数字不变。
- **`swob insights --json` 的估价对账不再因浮点末位判为不一致**：`reconciliation.valuation.ok` 原来用绝对阈值 1e-12 比较同一批调用按会话求和与逐条求和的 USD，而合计超过 $8,192 时 1 个浮点末位就大于这个阈值，所以真实库上一直因求和次序的末位差（5e-11）为 `false`。现在 USD 允许合计的 1e-9 以内的差，覆盖率仍须一致。所有金额不变。
- **按模型与按日的用量不再计入分叉 Codex 子 agent 的副本**：会话审计的按模型各行（以及洞察报告的 topModels）、`swob insights` 的 `byModel` 和按日数字（`byDate`、热力图、小时分布、活跃天数、未知时间用量）原来把所有用量行都加进去，包括分叉子 agent 从父会话抄写的行，于是按模型各行之和可能大于会话估价，`byModel`、`byDate` 的合计也可能大于 `totalTokens`。现在每个计费事实只算一次，算的就是合计所算的那次调用；Codex 按模型行的 `turns` 相应变成这些调用的条数。合计不变。
- **用量账本不再因一场会话降级而整轮回滚**：OpenCode 或 ZCode 会话从逐调用用量退回旧的会话合计时，账本会撞上当初被它替换掉的那条合计记录的主键，把所有来源这一轮的更新一起回滚，Insights 页于是悄悄停在旧快照上（一台真实机器上自 2026-08-20 起如此）。现在，本轮退回会话合计、或本轮读不到用量（读取失败、只剩占位）的会话保留上次入账的用量，其余会话照常入账；只剩那条被替换合计记录的会话重新计入这份合计。退回时也保留逐调用记录被拒的原因码。
- **Insights 页显示账本更新时间与同步失败**：筛选栏下方一行显示「账本更新于 <时间>」，后台用量同步持续失败时显示「上次同步失败：<错误码>，连续 N 次」。失败也会写进 lifecycle.log：开始失败、错误码变化、恢复时各一行。
- **`swob insights` 对两场会话共有的调用只算一次，与 Insights 页一致（数值会下降）**：续接或分叉的转录可能带着另一场会话也记下的调用，`swob insights` 原来在两场会话里各算一次，而 Insights 页每个计费事实只算一次。现在合计、`valuation`、`bySource`、`byModel`、`byProject`（`topProjects`）、`byFolder` 以及按日、按小时的数字都只算一次，记在 Insights 页选中的那场会话上，所以默认输出与 `--summary` 的数值会下降（本机实测 Claude Code 约 −$81.05、−183,968,593 token），模型与项目的名次也可能变；`bySession` 仍逐会话列出各自的全部调用，因此加起来不再等于合计。没有计费身份的调用（legacy 聚合、Codex 旧总账、没有 id 的 Claude 行）不跨会话合并。`--json` 新增 `reconciliation.crossSessionDuplicateFacts`、`reconciliation.crossSessionDuplicateTokens` 与 `reconciliation.valuation.crossSessionDuplicateUsd`，用来对上这个差额；没有字段改名或删除。桌面端的审计报告与 HTML 洞察报告仍按会话累加。
- **Library 补水完成前，Insights 不再删掉只剩 Library 备份的会话的用量**：原始文件已删、只剩 Library 备份的会话，要等 Library 补水把它加回会话列表；而每次整体重新加载会话（再次加载会话，例如在 Agent 窗口打开历史，或会话操作触发的重载）都会把它拿掉，直到下一次补水。这段时间里的用量同步把它当成缺席：低于删除保护闸门的当轮删除用量行，数量多的先扣留、再被下一次加载确认删除（在一份真实库上是 1,228 场 Claude Code 会话）。现在这类重载之后的补水完成之前，缺席会话的用量行一律保留，已补水的 Library 独有会话在重载后也仍留在账本的输入里；补水完成后的第一次同步照常判定删除，这段时间里发生的真实删除等到那次同步再处理。估值历史本来就不受影响。
- **本版本之前缓存的会话会重新读取一次**：摘要缓存和搜索索引原来只凭修改时间和大小认文件，读取逻辑修过之后没再改动的文件一直沿用旧的读取结果：含 U+2028/U+2029 行分隔符的记录在会话里和搜索里都缺着，Codex 的压缩次数与用量停在旧数字，Cursor 会话停在旧的工作目录。升级后第一次启动会把所有会话重新读取一次（读完之前列表显示上次的结果，Codex 用量等数字可能随后下降）；搜索索引在后台逐个文件重建，文件重建完之前仍能搜到旧结果。读不出来的会话文件，这一轮先不显示、下一轮再读，不再被当成空会话记住。
- **Cursor 会话的工作目录改为按转录线索、并经 Cursor 自己的记录确认**：工作目录改为按转录里的线索确定，并用 Cursor 自己的 `chats/<md5(路径)>/` 记录确认。本机实测 35 场会话的工作目录随之变化，桌面端的项目分组和 Insights 里 29 个项目名的归属也跟着变。目录已删除的会话保留线索里的路径。
- **Insights 不再因为会话本轮缺席而删除用量与估值历史**：某些会话本轮读不到时（缓存重置、SQLite 探测失败、provider 未就绪），它们的用量行和估值历史原来会被删掉；现在保留，大批量或整源消失要等下一次独立加载确认后才删除。
- **`swob doctor checkup` 不再把内核已经挂上的 guardian 误判为孤儿**：没有自己用量事件、且挂在另一个子 agent（而非顶层会话）下面的 Codex guardian（或其他非 thread-spawn 子 agent），原来会被①判成无法解释的 `codex.nested-subagent-orphan`，即便内核早已把它归并进那场顶层会话的家族树。现在①在判定零用量 guardian 为无法解释之前，会照内核同样的方式逐级上溯父链；真正断链、够不到任何顶层会话的 guardian 判定不变。
- **升级后第一次启动在启动阶段就重建搜索索引**：摘要缓存或搜索索引是旧版本写的时，启动阶段自己的全量投影会逐个文件重投影搜索索引（并刷新 Insights），即使没有 Library 会话变化，不再等之后碰巧来的某次全量刷新。`~/.claude-session-manager/lifecycle.log` 记下 `cache-rebuild-started` 与 `cache-rebuild-finished`（原因、计数、耗时，不含路径）。两份缓存都是当前版本时，启动不做额外的事。
- **血统注册表升级后重建一次，不以别名和裁决为代价**：Library 里的 `.session-lineage.json` 是旧会话别名和手工血统裁决唯一的存放处。新版本第一次加载完成后，旧版本建的注册表在后台重建一次：先把旧文件原样备份到 `~/.claude-session-manager/lineage-backups/`（替换失败重试时沿用这一份），再原子写入新文件；重建若会丢掉别名或裁决就拒绝替换（裁决已无法应用时，它对应的别名会去掉并记日志）。Swob 自动识别的血统关系（relations）按当前源文件重算，可能随之变化，旧文件留在备份里。存在但读不出的注册表不再被新建的覆盖；以前文件损坏或读不出时会被悄悄换掉，别名随之丢失。`swob lineage` 遵循同样的规则，拒绝时退出码为 1，错误码为 `LINEAGE_REGISTRY_UNREADABLE`、`LINEAGE_REGISTRY_ENTRIES_LOST`、`LINEAGE_REGISTRY_CHANGED` 或 `LINEAGE_REGISTRY_BACKUP_FAILED`，文件保持不变。
- **`swob doctor checkup` 新增⑤ Token 判定**：Claude 与 Codex 各自独立从原始会话数据复算一遍（Claude：按 `message.id`/`requestId` 去重，同一请求的多条流式快照里有 `stop_reason` 的那条胜出，带 `forkedFrom` 标记的行按继承副本剔除；Codex：每条累计 `token_count` 快照按自身签名全局去重，分叉子 agent 抄写的前缀会作为去重的副作用一并剔除），与内核自己算出的逐会话账本对拍：既比来源级总量（非缓存输入、缓存读、输出、推理，Claude 另加缓存写），也比逐场是否分量全等。每个分量偏差都在 0.1% 以内、且至少 99% 的会话逐场全等才判「通过」；偏差在 1% 以内、或差额完全落在已登记的 Claude 缓存写「聚合值 vs 5 分钟/1 小时细分值」口径差范围内，判「注意」；其余情况判「不通过」，包括标准答案测得有用量而 Swob 会把该会话显示成 0 的情形。Cursor（以及其他没有权威用量计数的来源）如实标为不适用，不是 0。体检程序版本升到 1.3.0。

## v1.4.0 — 2026-08-08

### 新功能

- **13 个原生来源 + 1 个兼容来源**：Antigravity、Grok、Kimi、Hermes、Qoder、Trae、Gemini 加入 Claude Code、Codex、Cursor、OpenCode、ZCode、Pi 的原生解析行列；CC-Mirror 继续以兼容格式支持。能力分级坚持以证据为准：加密或受限格式如实降级，不做猜测。
- **Windows x64 Beta（未签名）**：首个 Windows 构建，覆盖引导、发现、阅读、搜索、Insights 与设置。Beta 指仅经 CI 验证，详见已知边界。
- **启动性能重构**：热启动改为计算真实脏集而非全量重同步；冷同步走有界批处理并支持可恢复 checkpoint；Search／Usage 投影收进单队列按空闲调度。在约 1450 个会话的真实库上，升级后首次启动约 10 分钟完成一次性全量补齐，之后每次启动约 1 分钟内安静；旧版 20 分钟仅完成 22%。
- **看得见的库健康**：健康状态机与新鲜度追踪、可见的健康面板（附引导式恢复入口）、恢复补偿队列。
- **声明式镜头包**：用 `.swoblens` 文件扩展 Swob，无需写代码。
- **可审计成本账本**：成本与估值维度、价格快照、大账本分页与估值历史查询；镜头平台与主题选择器一并就位。

### 修复

- 写入进程崩溃后可能让整个库静默变成只读；现在 writer 租约会显式恢复，健康状态如实上报而非隐藏。
- 会话索引不再落后实时活动数小时；识别以 `=` 形式传参启动的 resume 会话。
- 修复 Galaxy 布局回归与渲染闪烁（来源分区聚类 + 画布尺寸守卫）。
- 库偏好设置在启动 hydration 竞态下不再丢失。
- 退出时库 worker 不再触发 native abort 或多余告警。

### 已知边界

- `swob active` 检测不到两类会话：① Claude Desktop 内嵌运行的 Claude Code（不产生原生 `claude` 进程）；② 未带 `--resume` 启动的新会话（无 session id 可关联）。能力矩阵已如实标注该边界。
- Windows 构建为 Beta 且未签名：仅经 CI 验证，未经过 Windows 11 真机手工验收，出现 SmartScreen 提示属预期。
- 升级后首次启动会做一次性全量补齐（大库约 10 分钟）以建立新 checkpoint；之后的启动均为增量。

## v1.3.1 — 2026-07-24

### 新功能

- **逻辑会话历史**：把重复包与 compact／resume 产生的延续关系连成一条可解释的历史，同时保留底层物理会话证据。
- **个性化展示**：可选择用户头像，并用本地托管的 PNG、JPEG、WebP 或经安全清洗的 SVG 覆盖内置 provider 图标。
- **签名更新通道**：v1.3.0 及以上版本可在候选包通过真实安装与重启验收后，接收经过门禁的应用内签名更新。

### 修复

- 会话数量、来源健康与 Insights 统一使用本地权威证据；过期或不完整数据不再导致洞察页崩溃。
- 详情数据不完整时，优先展示现有 transcript；确实无法恢复时给出可恢复／不可用原因，不再出现空白详情。
- “全部会话”可可靠折叠，大分组保持流畅，搜索会显示真实空结果；窄窗口仍保留可读的对话主栏。
- 右侧详情统一提供成果、活动与详情三个入口；已知文件和会话延续关系不再被静默遗漏。
- CLI 安装通过 macOS 授权流程自动完成所需的特权 symlink，不再要求用户复制 `sudo ln`。
- 用户头像与 provider 图标覆盖持久保存、即时生效，并拒绝未注册来源和不安全 SVG 内容。
- 官网主下载按钮会直接下载识别到的 Mac 架构，并始终提供另一架构的明确备用链接。

## v1.3.0 — 2026-07-23

> **需要手动升级：** v1.2.0 及更早版本无法通过自动更新跨越旧的 ad-hoc/未签名信任边界。请下载对应架构的 v1.3.0 DMG 并覆盖安装一次；v1.3.0 不发布更新 metadata。

### 新功能

- **Session Galaxy 与会话血统导航**：把大型会话库呈现为稳定、可筛选的图谱；可在会话界面内继续查看关联会话树、执行树与 Context Pressure。
- **分层的 Provider 能力**：解析 6 种原生格式与 1 种 Claude 兼容格式；另检测 4 个实验来源，但在拿不到消息正文时不宣称支持 transcript、检索或审计。
- **Session Audit 与 AI Insights**：新增有证据的质量诊断、统一且有边界的分析范围、逐请求 Token 归因与价值换算；任何可选 LLM 请求都必须先得到明确隐私确认。
- **Agent 工作流**：新增真实打包链路的 CLI 契约、多 LLM Profile、智能重命名、应用内 Agent 面板、分享图导出，以及 Command/View/Widget 注册表。
- **Library 与引导工具**：新增来源感知引导、容量预估、Vault 迁移、镜头、可撤销整理、重复包恢复计划与更清晰的来源健康状态。

### 修复

- 通过单写者租约、generation 校验和恢复安全状态迁移，让 Library 写入在不确定时可靠地 fail closed。
- 修复 source watcher、Keychain、打包 CLI 原生依赖、SSH/云 Resume 路由、会话导航与 provider 身份稳定性。
- 关闭安全与合规审计发现的路径越界、私密 fixture、凭据脱敏、provider 协议、包体边界和发布签名缺口。
- 统一用户可见文案、语言门禁、导航入口、Insights coverage 时间语义与 Galaxy 布局稳定性。

### 架构

- 搜索迁移到 SQLite FTS5；通过虚拟列表限制 renderer 工作量，合并 watcher，并把图谱布局放入独立 worker。
- 冻结统一 provider 协议与能力真相层，并用强类型注册表承载展示和扩展点。
- 新增 fail-closed 发布门禁，覆盖 Developer ID 签名、公证、staple、包体内容、更新 metadata 与签名更新信任根。
- Swob 从 v1.3.0 起改为 Apache-2.0；v1.2.0 及更早版本仍为 AGPL-3.0-only。
