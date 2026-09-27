/**
 * Registry of every sentence a report may contain. The privacy scanner only
 * accepts prose that equals one of these templates after numbers are
 * normalised, so new wording must be added here first.
 *
 * Placeholders: `{n}` → a number; `{source}` → a source display label.
 */
import type { CheckId, ReasonCode, Verdict } from './contract'

export const SOURCE_LABELS: Readonly<Record<string, string>> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  cursor: 'Cursor',
  opencode: 'OpenCode',
  zcode: 'ZCode',
  'cc-mirror': 'CC-Mirror',
  antigravity: 'Antigravity',
  grok: 'Grok Build',
  pi: 'Pi',
  kimi: 'Kimi Code',
  hermes: 'Hermes',
  qoder: 'Qoder',
  trae: 'Trae',
  gemini: 'Gemini CLI',
  'kimi-legacy': 'Kimi 旧版目录',
  'zcode-v2': 'ZCode v2 任务索引',
  all: '全部来源'
}

export const HEADLINES = {
  'inclusion.pass': '{n} 个原始单元全部纳入',
  'inclusion.gaps': '{n} 个原始单元里有 {n} 个没挂上会话，{n} 个是 Swob 不支持的格式',
  'content.pass': '逐文件读全，没有记录丢失',
  'content.pass-tool-lines': '逐文件读全，没有记录丢失；另有 {n} 行是工具自己写坏的，不计入结论',
  'content.loss': '有 {n} 条记录没读进来，其中 {n} 条是对话内容',
  'content.meta-only': '只丢了 {n} 条元数据记录，没有丢对话内容',
  'compaction.pass': '{n} 场会话的压缩次数逐场一致',
  'compaction.mismatch': '{n} 场会话里有 {n} 场压缩次数对不上：原始 {n} 处，Swob 认出 {n} 处',
  'lineage.pass': 'Codex 自己记录的 {n} 条血统边全部表达',
  'lineage.gaps': 'Codex 自己记录了 {n} 条血统边，Swob 少了 {n} 条',
  // C2c (④ P2-4 补): derivation edges clean but the fork/replay edges have a gap, or both have a gap
  'lineage.gaps-fork': 'Codex 自己记录的 {n} 条血统边全部表达，但另有 {n} 场（共 {n} 场）分叉/重放会话没有连起来',
  'lineage.gaps-both': 'Codex 自己记录了 {n} 条血统边，Swob 少了 {n} 条；另有 {n} 场（共 {n} 场）分叉/重放会话也没有连起来',
  // ⑤ tokens (C2a)
  'tokens.pass': '{n} 个来源的 Token 分量偏差都在 0.1% 以内，逐场全等率不低于 99%',
  'tokens.note': '{n} 个来源里有 {n} 项需要留意：偏差在 1% 以内，或属于已登记口径差',
  'tokens.mismatch': '{n} 个来源里有 {n} 项分量偏差超出可解释范围',
  // ⑥ resume (C2c)
  'resume.pass': '{n} 场会话干跑全部可恢复：文件在、目录在、内容锚点一致',
  'resume.problems': '{n} 个来源里有 {n} 项干跑没通过',
  'check.not-implemented': '本版体检还没有实现这一项',
  'check.undetermined': '本项这次无法判定',
  'check.not-applicable': '本项对本机数据不适用',
  // C1d (C1c acceptance P2-3): ② passes on the compared source while the other got no read count at all
  'content.pass-unread': '{source}：本轮未取得读数，没有参与比对；已比对的来源没有记录丢失',
  'content.pass-unread-tool-lines': '{source}：本轮未取得读数，没有参与比对；已比对的来源没有记录丢失；另有 {n} 行是工具自己写坏的，不计入结论'
} as const

export const OWNER_ACTIONS: Readonly<Record<Verdict, string>> = {
  pass: '不用管',
  warn: '知道即可，等下个版本修',
  fail: '转给开发；修好之前别信这一项的数字',
  undetermined: '暂时无需处理，等体检补齐',
  'not-applicable': '不适用，无需处理'
}

interface FindingText { ownerLine: string; engineerHint: string }

/** Owner sentence + engineer locator per reason code used in findings. */
export const FINDING_TEXT: Readonly<Partial<Record<ReasonCode, FindingText>>> = {
  'content.line-separator-split': {
    ownerLine: '{source}：有 {n} 条记录没读进来，其中 {n} 条是你本人发的消息。这些记录里带有特殊的行分隔符，Swob 这次读到的比原始记录少（旧版 Swob 也曾在这类记录上丢数据）',
    engineerHint: 'src/main/jsonl-lines.ts#readJsonlRecords：F1a 起只按 LF 分行，U+2028/U+2029 与单独的 CR 不再断行；此码只在某文件内核实测读入数少于普查可解析数、且差额能归到含这类字符的记录时出现（src/checkup/checks/content.ts#allocateLoss），先查读行器是否又按它们断行'
  },
  'content.unexplained-loss': {
    ownerLine: '{source}：有 {n} 条记录没读进来，原因还没查明',
    engineerHint: 'src/main/jsonl-lines.ts#readJsonlRecords：内核读行器（经 session-loader 与 codex-loader 的 WithStats 入口读取，含 Claude 子 agent 文件；C1c 起 Codex 也会出此码）的读入数少于普查数出的可解析记录，差额超出该文件含分隔符记录能解释的部分（src/checkup/checks/content.ts#allocateLoss）'
  },
  'content.swob-extra-records': {
    ownerLine: '{source}：有 {n} 个文件 Swob 读出的记录比原始记录还多，原因还没查明',
    engineerHint: 'src/main/jsonl-lines.ts#readJsonlRecords：内核读行器（经 session-loader 与 codex-loader 的 WithStats 入口读取，含 Claude 子 agent 文件）的读入数多于普查数出的可解析记录'
  },
  'content.tool-bad-line': {
    ownerLine: '{source}：工具写坏的行 {n}。这是工具自己写坏的，不是 Swob 丢的，单独列出，不计入本项结论',
    engineerHint: 'census/jsonl-census.ts：只按换行符分行后 JSON.parse 失败的非空行；单列，不参与 ② 的结论'
  },
  'content.truncated-tail': {
    ownerLine: '{source}：有 {n} 个文件的最后一行没写完整，多半是工具写到一半被打断；不是 Swob 丢的，不计入本项结论',
    engineerHint: 'census/jsonl-census.ts：末行无换行符且无法解析；单列，不参与 ② 的结论'
  },
  'readout.parse-timeout': {
    ownerLine: '{source}：有 {n} 个文件读取超时或没读成，这次没有参与比对',
    engineerHint: 'src/main/session-loader.ts#parseSessionFileWithStats：30 秒超时或读流出错时返回已读部分并置 truncated（jsonl-lines.ts#readJsonlRecords）；体检据此标 partial（耗时到超时或调用抛错也算），该文件不参与 ② 的比对'
  },
  'census.file-changed-during-run': {
    ownerLine: '{source}：有 {n} 个文件在体检期间还在被写入，这次没有参与比对',
    engineerHint: 'census：读前读后 stat 不一致，或读数完成后 stat 已变化'
  },
  'census.lower-symlink': {
    ownerLine: '{source}：来源目录里有 {n} 个符号链接，Swob 不会顺着它去读',
    engineerHint: 'src/main/session-loader.ts#findSessionFilesInProjectRoots：Dirent 不跟随下层链接'
  },
  'census.unreadable': {
    ownerLine: '{source}：有 {n} 个文件这次读不了，没有参与比对',
    engineerHint: 'census：文件读取失败（权限或已被删除）'
  },
  'codex.legacy-compacted-unrecognized': {
    ownerLine: 'Codex：{n} 场会话里一共发生过 {n} 次上下文压缩，Swob 一次都没认出来',
    engineerHint: 'src/main/codex-loader.ts#codexToRawMessages：F1b 起按文件的主格式识别压缩，文件里有 compacted 行就只数 compacted（同一载荷只算一次）；仍出现此码表示这场会话含旧格式压缩记录而 Swob 计数为 0（C1c 收紧的判据），旧格式一条都没认出来'
  },
  'compaction.count-mismatch': {
    ownerLine: '{source}：有 {n} 场会话的压缩次数和原始记录对不上',
    engineerHint: 'compactCount 与该会话全部物理文件里去重后的压缩标记数不等'
  },
  'inclusion.unexplained': {
    ownerLine: '{source}：有 {n} 个原始单元没被 Swob 纳入，原因还没查明',
    engineerHint: 'src/main/session-loader.ts#loadLegacySessionSnapshot：原始单元不在任何会话的 filePath/allFilePaths/subagents 里'
  },
  'claude.subagent-orphan': {
    ownerLine: 'Claude Code：有 {n} 个子 agent 文件找不到它的主会话文件，用量没算进任何会话',
    engineerHint: 'src/main/session-loader.ts#findClaudeSubagentFilesNearMain：主会话文件已不在本机'
  },
  'claude.subagent-owner-not-included': {
    ownerLine: 'Claude Code：有 {n} 个子 agent 文件的主会话没被纳入，所以它们也没算进去',
    engineerHint: 'src/main/session-loader.ts#loadRelatedClaudeSubagentMessages：主会话未成为会话'
  },
  'claude.subagent-too-deep': {
    ownerLine: 'Claude Code：有 {n} 个子 agent 文件放得太深，Swob 不会去找',
    engineerHint: 'src/main/session-loader.ts#findClaudeSubagentFilesNearMain：只找 subagents 下两层'
  },
  'claude.unrecognized-jsonl-location': {
    ownerLine: 'Claude Code：有 {n} 个记录文件放在 Swob 不认识的位置',
    engineerHint: 'src/main/session-loader.ts#findSessionFilesInProjectRoots：只认项目目录下一层与 subagents'
  },
  'codex.nested-subagent-orphan': {
    ownerLine: 'Codex：有 {n} 个「子 agent 又派出的子 agent」没挂到任何会话上，它们的用量也一起丢了',
    engineerHint: 'src/main/session-loader.ts#loadLegacySessionSnapshot：F1b 起子 agent 沿 parentSessionId 逐级上溯（最多 16 层）挂到顶层会话；走不到 Swob 的顶层会话才挂不上：链在中间断了（某层 rollout 已不在、没写父会话编号，或顶层祖先不是 Swob 的会话）、父子成环、超过 16 层'
  },
  'codex.subagent-parent-missing': {
    ownerLine: 'Codex：有 {n} 个子 agent 的父会话不在 Swob 的会话里（不在本机或被排除），挂不上',
    engineerHint: 'src/main/session-loader.ts#loadLegacySessionSnapshot：parent_thread_id 不是任何顶层会话'
  },
  'codex.subagent-no-parent-id': {
    ownerLine: 'Codex：有 {n} 个子 agent 没写父会话编号，挂不上',
    engineerHint: 'session_meta 缺 parent_thread_id'
  },
  'codex.child-usage-not-attributed': {
    ownerLine: 'Codex：有 {n} 个子 agent 的用量没有并进父会话',
    engineerHint: 'src/main/session-loader.ts#attributeUsageEventsInPlace：父会话用量里找不到该子文件的来源标记'
  },
  'codex.no-session-id': {
    ownerLine: 'Codex：有 {n} 个会话文件没有会话编号，Swob 读不出来',
    engineerHint: 'src/main/codex-loader.ts#extractSessionId：无 session_meta 且文件名无编号'
  },
  'codex.non-rollout-file': {
    ownerLine: 'Codex：会话目录里有 {n} 个不是 rollout 的记录文件，Swob 不读',
    engineerHint: 'src/main/codex-loader.ts#scanCodexDirectory：只收 rollout-*.jsonl'
  },
  'codex.rollout-not-in-thread-db': {
    ownerLine: 'Codex：有 {n} 个会话文件不在 Codex 自己的线程库里，原因未查明',
    engineerHint: 'state_*.sqlite threads.rollout_path 不含该文件（第一方索引不完整）'
  },
  'codex.thread-rollout-missing': {
    ownerLine: 'Codex：线程库里有 {n} 个线程的会话文件已经不在了',
    engineerHint: 'state_*.sqlite threads.rollout_path 指向不存在的文件'
  },
  'codex.thread-rollout-outside-roots': {
    ownerLine: 'Codex：线程库里有 {n} 个线程的会话文件在 Swob 不扫的目录里',
    engineerHint: 'src/main/codex-session-roots.ts#configuredCodexRoots：rollout 不在任何已配置的 Codex 根下'
  },
  'codex.thread-not-in-census': {
    ownerLine: 'Codex：线程库里有 {n} 个线程的会话文件没被清点到，原因未查明',
    engineerHint: 'census/codex-census.ts：rollout 存在且在根内，但清点没有列出'
  },
  'codex.state-db-unreadable': {
    ownerLine: 'Codex：线程库这次打不开，三方对账没有做',
    engineerHint: 'census/codex-state-db.ts：better-sqlite3 只读打开失败'
  },
  'unsupported.kimi-legacy-sessions': {
    ownerLine: 'Kimi 旧版目录里有 {n} 场会话，Swob 不支持这种格式',
    engineerHint: 'src/main/providers/kimi-provider.ts：只认 ~/.kimi-code/sessions 下的 wire 记录，不扫 ~/.kimi/sessions'
  },
  'unscanned.zcode-v2-tasks': {
    ownerLine: 'ZCode v2 的任务索引 Swob 不读，是不是会话还没核实',
    engineerHint: 'src/main/zcode-loader.ts：只读 ~/.zcode/cli/db 下的会话库'
  },
  // —— C1b addition ——
  'readout.source-empty': {
    ownerLine: '{source}：本机有这个来源的数据，但 Swob 这次一场会话都没读到',
    engineerHint: 'src/main/session-loader.ts#loadAllSessions：只读加载时这个来源返回 0 场会话，而来源根存在；先查对应 loader 是否把读取失败静默成了空结果'
  },
  // —— C1c additions ——
  'compaction.multi-copy-explained': {
    ownerLine: 'Codex：有 {n} 场会话在磁盘上有多份副本，Swob 按其中一份计数，标准答案取各份的并集；差异已解释，不是识别错误',
    engineerHint: 'src/main/session-loader.ts#loadLegacySessionSnapshot：同一 id 的多份副本只保留账单最大的那份，compactCount 取那一份；该场的 Swob 计数等于其中一份副本按内核规则数出的标记数'
  },
  'codex.compaction-rule-difference': {
    ownerLine: 'Codex：有 {n} 个会话文件的压缩记录写法特殊（新旧两种并存 {n} 个、只有压缩事件 {n} 个），逐场比对按 Swob 的计法数；这是已知的口径差，单独列出，不计入本项结论',
    engineerHint: 'checks/compaction.ts#kernelRuleMarkers：同一文件既有 compacted 又有 compaction item 时只数 compacted；两种都没有时逐行数 *compact* 事件（与 src/main/codex-loader.ts#codexToRawMessages 的 F1b 规则对齐）'
  },
  'content.swob-read-error': {
    ownerLine: '{source}：有 {n} 个文件没拿到 Swob 的逐文件读入数（读取出错，或这次没有读），没有参与比对，也不做推算',
    engineerHint: 'src/checkup/readout.ts#readSwobReadout：没有这个文件的逐文件读数（parseCodexFileWithStats 读取抛错，或文件不在这次读数的清单里）；不推算，不参与 ② 的比对'
  },
  // —— C2b (④ lineage) additions ——
  'codex.derivation-edge-unexpressed': {
    ownerLine: 'Codex：自己记录了 {n} 条「谁派出了谁」，Swob 里少了 {n} 条',
    engineerHint: 'src/checkup/census/codex-state-db.ts thread_spawn_edges vs src/main/session-loader.ts#loadLegacySessionSnapshot 的子 agent 挂载：边的子线程不在任何会话的 subagents[] 里，或挂错了父'
  },
  'codex.derivation-edge-swob-extra': {
    ownerLine: 'Codex：Swob 挂了 {n} 个子 agent，但线程库的派生关系表里找不到对应的边',
    engineerHint: 'src/main/session-loader.ts#loadLegacySessionSnapshot 挂到某会话的 subagents[]，census/codex-state-db.ts 的 thread_spawn_edges 里没有以它为子线程的行；标 [E]，可能是线程库本身遗漏'
  },
  'codex.fork-edge-unexpressed': {
    ownerLine: 'Codex：有 {n} 场（共 {n} 场）分叉/重放会话，Swob 没有把它和原会话连起来',
    engineerHint: 'session_meta.forked_from_id（census/codex-census.ts codexTopLevelForkEdges）vs src/main/codex-loader.ts#extractCodexReplayParentId 写入的 branchParentId'
  },
  'codex.fork-edge-swob-extra': {
    ownerLine: 'Codex：Swob 认为有 {n} 场会话是分叉/重放来的，但线程自己的记录里没有这条证据',
    engineerHint: 'branchParentId（codex:<id> 前缀）在 census/codex-census.ts 的 codexTopLevelForkEdges 里找不到对应的 forked_from_id；标 [E]'
  },
  'claude.continuation-edge-unexpressed': {
    ownerLine: 'Claude Code：有 {n} 对文件明显是「接着上一场继续聊」，Swob 没有把它们连成一场会话',
    engineerHint: 'census/claude-census.ts 的 sessionIds 与 basenameId 交叉引用 vs readout.ts ReadoutSession 的 paths / continuationSessionIds'
  },
  'claude.resume-fork-edge-unexpressed': {
    ownerLine: 'Claude Code：有 {n} 对文件开头原样复制了另一个文件至少 8 条消息，Swob 没有把它们连起来',
    engineerHint: 'census/claude-census.ts#findClaudeUuidOverlapPairs（uuid 前缀重叠 ≥8，标 [E]）vs branchParentId/branchChildIds（session-loader.ts#linkCrossSessionBranches 或 forkedFrom 字段）；两套独立实现的分歧只报观察，不影响结论'
  },
  'claude.branch-edge-swob-extra': {
    ownerLine: 'Claude Code：Swob 认为有 {n} 场会话是恢复/分叉来的，但原始文件里找不到这条证据',
    engineerHint: 'branchParentId/branchChildIds（session-loader.ts#linkCrossSessionBranches 或 forkedFrom 字段）在 census/claude-census.ts#findClaudeUuidOverlapPairs 的重叠证据里找不到对应的文件对；标 [E]，父文件可能已被清理'
  },
  // —— C2a additions (⑤ tokens) ——
  'tokens.deviation-high': {
    ownerLine: '{source}：Token 总量和标准答案（复算）相比偏差达 {n}%，超出可解释范围，这次先别用这项数字下结论',
    engineerHint: 'src/checkup/checks/tokens.ts：来源级 billingTotal 偏差 |Swob−oracle|/oracle 超过 1%，且未落在已登记口径差（tokens.cache-write-calibration-difference）范围内；标准答案见 census/codex-census.ts#codexRecountB、census/claude-census.ts#claudeRecountUsage'
  },
  'tokens.deviation-note': {
    ownerLine: '{source}：Token 总量和标准答案相比有 {n}% 的偏差，在允许范围内，暂不影响结论',
    engineerHint: 'src/checkup/checks/tokens.ts：来源级偏差 >0.1% 且 ≤1%（设计 §四 4.5 阈值表「注意」档）'
  },
  'tokens.session-mismatch': {
    ownerLine: '{source}：有 {n} 场会话的四项分量和标准答案对不上',
    engineerHint: 'src/checkup/checks/tokens.ts：Swob 每场会话的四分量（非缓存输入/缓存读/输出/推理）与同一会话族标准答案的四分量逐项比对，任一项不等就计入'
  },
  'tokens.cache-write-calibration-difference': {
    ownerLine: '{source}：有 {n} 次请求的缓存写入，Swob 取 5 分钟/1 小时细分值，标准答案取聚合值，两者对不上；这是已知口径差，不是识别错误',
    engineerHint: 'src/main/token-accounting.ts#accountClaudeUsage（:554-568）：有 5m/1h 细分时优先用细分值而不是 usage.cache_creation_input_tokens 聚合值，并把差额记进该事件的 warnings；census 的 Claude 复算取聚合值（ccusage 同类工具的口径），两者的差额即由此产生'
  },
  'tokens.swob-unavailable-as-zero': {
    ownerLine: '{source}：有 {n} 场会话标准答案测得有 Token 用量，但 Swob 这次显示不可用，不应该被当成 0',
    engineerHint: 'src/checkup/readout.ts#readoutTokensFromAccounting：会话的 tokenAccounting 缺失或 provenance 为 unavailable 时，这次比对必须显示 [U] 而不是把它当 0 参与总量'
  },
  // —— C2c additions (④ F1n/G1 fork-edge "explained" rule) ——
  'lineage.fork-child-empty-excluded': {
    ownerLine: '{source}：有 {n} 场分叉/重放会话的子会话本身没有对话内容，① 已经把它排除，不算未表达',
    engineerHint: 'census/codex-census.ts codexTopLevelForkEdges 的子会话 unit.assistantSide === 0（与 checks/inclusion.ts classifyCodexUnits 判定 codex.empty-session 的条件一致）：子会话没有产生任何对话，从未成为 Swob 会话，① 已排除；④ 不再把这种边计入未表达，但仍列出以便核对'
  },
  // —— C2c additions (⑥ resume dry run) ——
  // environment class: the owner can fix these locally (reinstall / relink / restore the directory)
  'resume.program-not-found': {
    ownerLine: '{source}：抽样会话里有 {n} 场，恢复命令要用的程序在 PATH 上找不到。这是电脑的问题，装上对应的程序就好',
    engineerHint: 'src/checkup/checks/resume.ts#locateProgram：lstat 在 PATH 每一段都找不到这个名字的可执行文件（stat 失败或不可执行）'
  },
  'resume.program-broken-symlink': {
    ownerLine: '{source}：抽样会话里有 {n} 场，恢复命令要用的程序是一个坏的符号链接，指向的版本已经不在了。重新安装或者修一下这个链接就好',
    engineerHint: 'src/checkup/checks/resume.ts#locateProgram：lstat 找到了这个名字，但 realpath 解析失败（悬空链接）；替代 src/main/resume-audit.ts#isBinaryAvailable 只会把这种情况报成"找不到"、说不出原因'
  },
  'resume.directory-missing': {
    ownerLine: '{source}：有 {n} 场会话记录的工作目录已经不在了。这是电脑的问题，恢复前先确认项目目录还在',
    engineerHint: 'src/checkup/checks/resume.ts#classifyBucket：ReadoutSession.resumeCwd（来自 SessionSummary.resumeCwd）这次用 fs.statSync 复核后不存在'
  },
  // data / anchor class: hand to dev, the number itself should not be trusted yet
  'resume.file-missing': {
    ownerLine: '{source}：有 {n} 场会话记录的文件这次已经找不到了，点"恢复"大概率会 404。这个转给开发',
    engineerHint: 'src/checkup/checks/resume.ts#classifyBucket / #anchorStatusFor：ReadoutSession.primaryPath 这次用 fs.statSync 复核后不存在（或 L3 锚点比对时同一文件已读不到，would-404）'
  },
  'resume.command-syntax-invalid': {
    ownerLine: '{source}：有 {n} 场会话，Swob 自己拼出来的恢复命令连语法都不对，这不是电脑的问题，是 Swob 的 bug，转给开发',
    engineerHint: 'src/checkup/checks/resume.ts#zshSyntaxOk：`zsh -n -c "<命令>"` 语法检查未通过（只解析不执行）；命令由 src/main/session-actions.ts#buildResumeCommand 拼出'
  },
  'resume.anchor-mismatch': {
    ownerLine: '{source}：有 {n} 场会话，点「恢复」打开的内容和 Swob 里显示的不是同一份；我们在修，不用你处理',
    engineerHint: 'src/checkup/checks/resume.ts#classifyAnchorComparison -> readout.ts#classifyResumeAnchors（复用 src/main/resume-verifier.ts#classifyResumeL3，[D] 非独立来源）：恢复侧（Claude 取 sessionId 命名文件即 primaryPath／Codex 取 state db threads.rollout_path 指向文件，无行退回 primaryPath）与展示侧（session.paths 内锚点时间戳最新的文件）hash 不相等'
  },
  // —— C2c-3 additions (⑥ resume L3 口径修正：恢复侧 vs 展示侧，见 F1o 诊断) ——
  'resume.anchor-cache-lag': {
    ownerLine: '{source}：有 {n} 场会话，Swob 这次读到的内容比它自己记录的更新时间还新，大概率是内部缓存没跟上，不是内容真的对不上。我们在看，不用你处理',
    engineerHint: 'src/checkup/checks/resume.ts#classifyAnchorComparison：展示侧（session.paths 内锚点时间戳最新的文件）自身锚点时间戳晚于 ReadoutSession.updatedAt（loadAllSessions 给出的摘要字段，可能来自内核复用的旧摘要缓存条目，见设计文档勘误），判定为缓存滞后而非数据错误'
  },
  'resume.anchor-cannot-verify': {
    ownerLine: '{source}：有 {n} 场会话，工具自己记录的恢复位置这次没能读到，没法确认和 Swob 显示的是不是同一份。转给开发看看',
    engineerHint: 'src/checkup/checks/resume.ts#codexRecoverySide：Codex state db threads.rollout_path 有行，但目标路径这次未解析到内容（realOrResolved 后不在 codexParsed 读取队列里，或读取本身失败）；未退回按 primaryPath 直接比较，因为已知恢复目标另有其文，静默回退可能掩盖真实分歧'
  }
}

/** A registered sentence the checkup no longer writes (see RETIRED_TEMPLATES). */
export interface RetiredTemplate {
  code: ReasonCode
  /** Where it was registered: a FINDING_TEXT field, or REASON_TEXT. */
  field: 'ownerLine' | 'engineerHint' | 'reasonText'
  /** The sentence exactly as it was registered (placeholders unfilled). */
  text: string
  /** The sentence that replaced it (today's text, or one retired later for the same code and field). */
  replacedBy: string
  /** The package that retired it, and the checkup version at that time. */
  retiredIn: string
}

/**
 * Retired sentences (C1d). A report stores the ownerLine / engineerHint of its findings as they were
 * written, and both privacy scanners accept registered text only; a reworded sentence therefore moves
 * here instead of being deleted, and registeredTemplateSet() keeps accepting it, so an older report can
 * still be rendered or scanned. REASON_TEXT is looked up by code when rendering (an older report shows
 * today's wording); its retired wording is listed too, so that every sentence ever registered stays
 * registered. Rewording keeps CHECKUP_VERSION: reports of one checkup version may carry either sentence.
 * A sentence that is still current never belongs here (privacy.test.ts).
 */
export const RETIRED_TEMPLATES: readonly RetiredTemplate[] = [
  {
    code: 'content.line-separator-split',
    field: 'ownerLine',
    text: '{source}：有 {n} 条记录没读进来，其中 {n} 条是你本人发的消息。原因是记录里有特殊的「行分隔符」，Swob 把一条记录切成两半后悄悄丢掉了',
    replacedBy: '{source}：有 {n} 条记录没读进来，其中 {n} 条是你本人发的消息。这些记录里带有特殊的行分隔符，Swob 这次读到的比原始记录少（旧版 Swob 也曾在这类记录上丢数据）',
    retiredIn: 'C1d (checkup 1.2.0)'
  },
  {
    code: 'content.line-separator-split',
    field: 'engineerHint',
    text: 'src/main/session-loader.ts#parseSessionFile / src/main/codex-loader.ts#parseCodexFile：readline 把 U+2028/U+2029 当换行',
    replacedBy: 'src/main/jsonl-lines.ts#readJsonlRecords：F1a 起只按 LF 分行，U+2028/U+2029 与单独的 CR 不再断行；此码只在某文件内核实测读入数少于普查可解析数、且差额能归到含这类字符的记录时出现（src/checkup/checks/content.ts#allocateLoss），先查读行器是否又按它们断行',
    retiredIn: 'C1d (checkup 1.2.0)'
  },
  {
    code: 'content.line-separator-split',
    field: 'reasonText',
    text: '记录里的特殊行分隔符让 Swob 把记录切断后丢掉',
    replacedBy: '带特殊行分隔符的记录没读全',
    retiredIn: 'C1d (checkup 1.2.0)'
  },
  {
    code: 'content.unexplained-loss',
    field: 'engineerHint',
    text: 'src/main/session-loader.ts#parseSessionFile：逐文件读入数少于规范读法且无行分隔符可解释',
    replacedBy: 'src/main/jsonl-lines.ts#readJsonlRecords：内核读行器（经 session-loader 与 codex-loader 的 WithStats 入口读取，含 Claude 子 agent 文件；C1c 起 Codex 也会出此码）的读入数少于普查数出的可解析记录，差额超出该文件含分隔符记录能解释的部分（src/checkup/checks/content.ts#allocateLoss）',
    retiredIn: 'C1d (checkup 1.2.0)'
  },
  {
    code: 'content.swob-extra-records',
    field: 'engineerHint',
    text: 'src/main/session-loader.ts#parseSessionFile：读入数多于规范读法',
    replacedBy: 'src/main/jsonl-lines.ts#readJsonlRecords：内核读行器（经 session-loader 与 codex-loader 的 WithStats 入口读取，含 Claude 子 agent 文件）的读入数多于普查数出的可解析记录',
    retiredIn: 'C1d (checkup 1.2.0)'
  },
  {
    code: 'readout.parse-timeout',
    field: 'engineerHint',
    text: 'src/main/session-loader.ts#parseSessionFile：30 秒超时后静默截断，或读取抛错',
    replacedBy: 'src/main/session-loader.ts#parseSessionFileWithStats：30 秒超时或读流出错时返回已读部分并置 truncated（jsonl-lines.ts#readJsonlRecords）；体检据此标 partial（耗时到超时或调用抛错也算），该文件不参与 ② 的比对',
    retiredIn: 'C1d (checkup 1.2.0)'
  },
  {
    code: 'codex.legacy-compacted-unrecognized',
    field: 'engineerHint',
    text: 'src/main/codex-loader.ts#codexToRawMessages：行类型联合里没有 compacted，只认 compaction 与 *compact* 事件',
    replacedBy: 'src/main/codex-loader.ts#codexToRawMessages：F1b 起按文件的主格式识别压缩，文件里有 compacted 行就只数 compacted（同一载荷只算一次）；仍出现此码表示这场会话含旧格式压缩记录而 Swob 计数为 0（C1c 收紧的判据），旧格式一条都没认出来',
    retiredIn: 'C1d (checkup 1.2.0)'
  },
  {
    code: 'codex.legacy-compacted-unrecognized',
    field: 'reasonText',
    text: 'Swob 不认旧格式的压缩记录',
    replacedBy: '含旧格式压缩记录的会话，Swob 一次都没认出来',
    retiredIn: 'C1d (checkup 1.2.0)'
  },
  {
    code: 'codex.nested-subagent-orphan',
    field: 'engineerHint',
    text: 'src/main/session-loader.ts#loadLegacySessionSnapshot：子 agent 只挂顶层父会话，没按 thread_spawn 逐级上溯',
    replacedBy: 'src/main/session-loader.ts#loadLegacySessionSnapshot：F1b 起子 agent 沿 parentSessionId 逐级上溯（最多 16 层）挂到顶层会话；走不到 Swob 的顶层会话才挂不上：链在中间断了（某层 rollout 已不在、没写父会话编号，或顶层祖先不是 Swob 的会话）、父子成环、超过 16 层',
    retiredIn: 'C1d (checkup 1.2.0)'
  },
  {
    code: 'resume.anchor-mismatch',
    field: 'ownerLine',
    text: '{source}：有 {n} 场会话，Swob 记的最后一句话和这次重新读到的对不上，恢复出来的内容可能是旧的或者串了分支。转给开发',
    replacedBy: '{source}：有 {n} 场会话，点「恢复」打开的内容和 Swob 里显示的不是同一份；我们在修，不用你处理',
    retiredIn: 'C2c-3 (checkup 1.3.0)'
  },
  {
    code: 'resume.anchor-mismatch',
    field: 'engineerHint',
    text: 'src/checkup/checks/resume.ts#anchorStatusFor -> readout.ts#classifyResumeAnchors（复用 src/main/resume-verifier.ts#classifyResumeL3，[D] 非独立来源）：hash 不相等',
    replacedBy: 'src/checkup/checks/resume.ts#classifyAnchorComparison -> readout.ts#classifyResumeAnchors（复用 src/main/resume-verifier.ts#classifyResumeL3，[D] 非独立来源）：恢复侧（Claude 取 sessionId 命名文件即 primaryPath／Codex 取 state db threads.rollout_path 指向文件，无行退回 primaryPath）与展示侧（session.paths 内锚点时间戳最新的文件）hash 不相等',
    retiredIn: 'C2c-3 (checkup 1.3.0)'
  },
  {
    code: 'resume.anchor-mismatch',
    field: 'reasonText',
    text: 'Swob 记的最后一句话和重新读到的对不上',
    replacedBy: '点「恢复」打开的内容和 Swob 显示的不是同一份',
    retiredIn: 'C2c-3 (checkup 1.3.0)'
  }
]

/** Generic sentences that are not tied to one finding code. */
export const GENERIC_TEMPLATES = [
  '本项在本版体检中返回无法判定'
] as const

const NUMBER_RE = /\d+(?:[.,]\d+)*/g

/** Normalise digits so templates and rendered sentences compare equal. */
export function normalizeTemplateText(text: string): string {
  return text.replace(/\{n\}/g, '#').replace(NUMBER_RE, '#')
}

function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return '0'
  if (Number.isInteger(value)) return String(value)
  return value.toFixed(3).replace(/0+$/, '').replace(/\.$/, '')
}

/** Fill `{n}` placeholders in order and `{source}` with the source label. */
export function fillTemplate(template: string, numbers: number[] = [], source?: string): string {
  let index = 0
  let out = template.replace(/\{n\}/g, () => formatNumber(numbers[index++] ?? 0))
  if (out.includes('{source}')) out = out.replace(/\{source\}/g, SOURCE_LABELS[source ?? ''] ?? SOURCE_LABELS.all)
  return out
}

// —— C1b registries: Markdown report, AI-diary digest, run-to-run comparison ——
//
// Every fixed piece of text the Markdown renderer, the digest and the comparison
// output. Besides `{n}` and `{source}` they use typed placeholders, filled only
// with values of one fixed shape (privacy.ts markdownSlots() checks them):
// {check}/{checks} check names · {sources} source names · {verdict} verdict word · {reason} reason text ·
// {oracles} oracle names · {sourceCounts} "source n" pairs · {kinds} loss kinds
// with counts · {measure} measure name · {unit} unit name · {date} local date ·
// {time} local date and time · {offset} UTC offset · {version} version ·
// {commit} 7-hex commit or — · {model} Mac model id · {tag} 6-hex machine tag ·
// {samples} 8-hex sample ids · {link} report note name · {root} fixed source
// root · {key} raw measure / diagnostics key (engineer audience only).

/** First line of every rendered report; lets a writer recognise its own file before overwriting it. */
export const MARKDOWN_MARKER = '<!-- swob-kernel-checkup v1 -->'

export const VERDICT_LABELS: Readonly<Record<Verdict, string>> = {
  pass: '通过',
  warn: '注意',
  fail: '不通过',
  'not-applicable': '不适用',
  undetermined: '无法判定'
}

export const CHECK_LABELS: Readonly<Record<CheckId, string>> = {
  inclusion: '① 会话纳入',
  content: '② 内容完整',
  compaction: '③ 压缩识别',
  lineage: '④ 血统与分支',
  tokens: '⑤ Token',
  resume: '⑥ 恢复（干跑）'
}

/** Short check names for the per-source overview columns. */
export const CHECK_SHORT_LABELS: Readonly<Record<CheckId, string>> = {
  inclusion: '① 纳入',
  content: '② 内容',
  compaction: '③ 压缩',
  lineage: '④ 血统',
  tokens: '⑤ Token',
  resume: '⑥ 恢复'
}

/** Owner-facing explanation of every reason code (shown as 「—（原因）」 and in verdict cells). */
export const REASON_TEXT: Readonly<Record<ReasonCode, string>> = {
  'census.file-changed-during-run': '体检期间还在被写入，这次没有参与比对',
  'census.lower-symlink': '来源目录里的符号链接，Swob 不会顺着去读',
  'census.unreadable': '这次读不了',
  'census.not-implemented': '本版体检还没有清点这个来源',
  'readout.not-isolated': 'Swob 侧读数没有在隔离环境里运行，为了安全没有读',
  'readout.kernel-error': 'Swob 内核读数出错',
  'readout.parse-timeout': '读取超时或没读成',
  'readout.provider-host-not-parsed-readonly': '这类来源在只读模式下不解析',
  'content.line-separator-split': '带特殊行分隔符的记录没读全',
  'content.tool-bad-line': '工具自己写坏的行',
  'content.truncated-tail': '文件最后一行没写完整',
  'content.unexplained-loss': '记录没读进来，原因还没查明',
  'content.swob-extra-records': 'Swob 读出的记录比原始记录还多',
  'content.swob-per-file-unavailable': 'Swob 没有按文件给出读入数',
  'content.swob-read-error': '读取出错或这次没有读，拿不到 Swob 的逐文件读入数',
  'codex.legacy-compacted-unrecognized': '含旧格式压缩记录的会话，Swob 一次都没认出来',
  'compaction.count-mismatch': '压缩次数和原始记录对不上',
  'compaction.fork-inherited-marker': '恢复或分叉时从父会话抄来的压缩标记',
  'compaction.multi-copy-explained': '会话有多份副本，Swob 按其中一份计数（差异已解释）',
  'codex.compaction-rule-difference': '压缩记录写法特殊，Swob 与标准答案的计法本来就不同（已知口径差）',
  'inclusion.unexplained': '没被纳入，原因还没查明',
  'claude.no-conversation-records': '文件里没有对话记录',
  'claude.subagent-no-conversation': '子 agent 文件里没有对话',
  'claude.subagent-orphan': '子 agent 找不到主会话',
  'claude.subagent-owner-not-included': '子 agent 的主会话没被纳入',
  'claude.subagent-too-deep': '子 agent 文件放得太深',
  'claude.unrecognized-jsonl-location': '记录文件放在 Swob 不认识的位置',
  'claude.continuation-shard': '同一场会话的续写文件',
  'claude.subagent-attached': '子 agent 已挂到主会话',
  'codex.empty-session': '空会话，助手一次都没回复',
  'codex.nested-subagent-orphan': '子 agent 又派出的子 agent 挂不上',
  'codex.subagent-parent-missing': '子 agent 的父会话不在',
  'codex.subagent-no-parent-id': '子 agent 没写父会话编号',
  'codex.child-usage-not-attributed': '子 agent 的用量没有并进父会话',
  'codex.child-attached': '子 agent 已挂到父会话',
  'codex.non-rollout-file': '不是会话记录文件，Swob 不读',
  'codex.no-session-id': '会话文件没有会话编号',
  'codex.duplicate-session-copy': '同一场会话的副本',
  'codex.rollout-not-in-thread-db': '会话文件不在 Codex 线程库里',
  'codex.thread-rollout-missing': '线程库里的会话文件已经不在了',
  'codex.thread-rollout-outside-roots': '线程库里的会话文件在 Swob 不扫的目录里',
  'codex.thread-not-in-census': '线程库里的会话文件没被清点到',
  'codex.state-db-missing': '本机没有 Codex 线程库',
  'codex.state-db-unreadable': 'Codex 线程库打不开',
  'unsupported.kimi-legacy-sessions': '旧版 Kimi 格式，Swob 不支持',
  'unscanned.zcode-v2-tasks': 'ZCode v2 任务索引，Swob 不读',
  'codex.derivation-edge-unexpressed': '线程库记录的派生关系，Swob 没有表达',
  'codex.derivation-edge-swob-extra': 'Swob 表达的派生关系，线程库里没有对应的边',
  'codex.fork-edge-unexpressed': '分叉/重放会话，Swob 没有连到原会话',
  'codex.fork-edge-swob-extra': 'Swob 认为的分叉关系，线程自己的记录里没有证据',
  'claude.continuation-edge-unexpressed': '续写的文件，Swob 没有连成一场会话',
  'claude.resume-fork-edge-unexpressed': '开头原样复制的文件，Swob 没有连起来',
  'claude.branch-edge-swob-extra': 'Swob 认为的恢复/分叉关系，原始文件里没有证据',
  'lineage.fork-child-empty-excluded': '分叉/重放会话的子会话没有对话内容，① 已排除，不算未表达',
  'codex.fork-usage-copy': '子 agent 抄写了父会话的用量快照',
  'tokens.deviation-high': 'Token 总量偏差超出可解释范围',
  'tokens.deviation-note': 'Token 总量有偏差，在允许范围内',
  'tokens.session-mismatch': '有会话的四项分量和标准答案对不上',
  'tokens.cache-write-calibration-difference': '缓存写入聚合值和 5 分钟/1 小时细分值对不上（已知口径差）',
  'tokens.swob-unavailable-as-zero': '标准答案测得有用量，但 Swob 显示不可用',
  'resume.program-not-found': '恢复命令要用的程序在 PATH 上找不到（环境问题）',
  'resume.program-broken-symlink': '恢复命令要用的程序是坏的符号链接（环境问题）',
  'resume.directory-missing': '记录的工作目录已经不在了（环境问题）',
  'resume.file-missing': '记录的文件这次已经找不到了',
  'resume.command-syntax-invalid': 'Swob 拼出来的恢复命令语法不对',
  'resume.anchor-mismatch': '点「恢复」打开的内容和 Swob 显示的不是同一份',
  'resume.anchor-cache-lag': '展示的内容比记录的更新时间还新，像是缓存滞后',
  'resume.anchor-cannot-verify': 'Codex 自己记录的恢复位置这次没能读到',
  'resume.probe-not-injected': '这个壳没有注入命令层探针，命令层这次不判定',
  'source.not-implemented': '本版体检还没有检查这个来源',
  'source.no-data': '本机没有这个来源的数据',
  'source.capability-unavailable': '这个来源本身不提供这项数据',
  'source.not-selected': '这次没有选这个来源',
  'check.not-implemented': '本版未实现',
  'checkup.self-test-failed': '自检没有全部通过，这次不给结论',
  'checkup.scope-not-implemented': '本版只支持全量体检',
  'checkup.no-verdict-checks': '没有能给出结论的检查项',
  'sqlite.readonly-sidecar-touch': '只读打开 SQLite 时碰到了旁路文件（-shm/-wal），数据本身没变',
  'sqlite.main-db-changed': 'SQLite 主库在体检期间有变化',
  'readout.source-empty': '本机有这个来源的数据，但 Swob 一场会话都没读到',
  'compare.schema-mismatch': '上次报告的格式版本不同',
  'compare.previous-no-fingerprint': '上次报告没有机器指纹（旧版体检生成的）',
  'compare.current-no-fingerprint': '这次报告没有机器指纹',
  'compare.fingerprint-mismatch': '上次报告来自另一台机器（机器指纹不同）',
  'compare.scope-mismatch': '上次报告的范围和这次不同'
}

/** Short reasons for the verdict cells of the per-source overview (explained by MARKDOWN_TEXT.sourcesLegend). */
export const REASON_SHORT_TEXT: Readonly<Partial<Record<ReasonCode, string>>> = {
  'source.not-implemented': '未检查',
  'check.not-implemented': '未实现',
  'source.no-data': '无数据',
  'source.capability-unavailable': '来源不提供',
  'source.not-selected': '未选',
  'readout.provider-host-not-parsed-readonly': '只读不解析',
  'readout.not-isolated': '未隔离',
  'readout.kernel-error': '内核出错',
  'checkup.scope-not-implemented': '范围未实现',
  // C1b-2: a graded cell whose only problem is the legacy Kimi directory (explained by MARKDOWN_TEXT.sourcesLegendLegacy)
  'unsupported.kimi-legacy-sessions': '旧版目录'
}

/** Measure units (contract MEASURE_UNITS). */
export const UNIT_LABELS: Readonly<Record<string, string>> = {
  units: '个单元',
  files: '个文件',
  records: '条记录',
  lines: '行',
  sessions: '场会话',
  markers: '处',
  edges: '条关系',
  threads: '个线程',
  snapshots: '条快照',
  bytes: '字节',
  percent: '%',
  ms: '毫秒',
  tokens: 'token',
  checks: '项检查',
  dirs: '个目录'
}

/** ④ lineage edge-type row labels (render-markdown.ts lineageTable). */
export const LINEAGE_EDGE_LABELS: Readonly<Record<string, string>> = {
  derivation: '派生边（thread-spawn）',
  fork: '分叉边（forked_from_id）',
  continuation: '续写边',
  subagent: '子 agent 边',
  resumeFork: '恢复/分叉边（uuid 重叠）'
}

/** Oracle ids (contract ORACLE_IDS). */
export const ORACLE_LABELS: Readonly<Record<string, string>> = {
  'census.claude-jsonl': 'Claude Code 原始文件逐行重读',
  'census.codex-jsonl': 'Codex 原始文件逐行重读',
  'codex.state-db': 'Codex 线程库',
  'census.unscanned-roots': 'Swob 不读的已知目录清点',
  'census.source-presence': '各来源目录是否存在',
  'fs.local-environment': '本机文件系统与 PATH 环境'
}

/** What a lost record was (② "丢失里有什么"). */
export const LOSS_KIND_LABELS = {
  user: '你的消息',
  assistant: '助手回复',
  tool_result: '工具结果',
  meta: '其他元数据',
  unexplained: '原因未查明'
} as const

/** Measure keys produced by C1a/C1b checks. Unregistered keys: not rendered for the owner, raw key for engineers. */
export const MEASURE_LABELS: Readonly<Record<string, string>> = {
  // ① inclusion
  sessions: 'Swob 会话数',
  branchViews: '文件内分支视图',
  discoveredMainFiles: 'Swob 发现的主会话文件',
  discoveredFiles: 'Swob 发现的会话文件',
  attachedSubagents: '已挂上的子 agent',
  becameSession: '成为会话',
  merged: '并入会话',
  excluded: '预期排除',
  unsupported: '不支持的格式',
  notIncluded: '未纳入',
  notIncludedUnexplained: '未纳入且原因未查明',
  inclusionRate: '纳入率',
  changedDuringRun: '运行中变化的单元',
  units: '原始单元',
  mainFiles: '主会话文件',
  subagentFiles: '子 agent 文件',
  otherJsonlFiles: '其他位置的记录文件',
  nonSessionFiles: '不是记录的文件',
  lowerSymlinks: '下层符号链接',
  topLevelFiles: '顶层会话文件',
  threadSpawnFiles: '派生出来的子 agent 文件',
  guardianFiles: 'guardian 文件',
  otherSubagentFiles: '其他子 agent 文件',
  unknownRoleFiles: '角色不明的文件',
  nonRolloutFiles: '不是会话记录的文件',
  threadsInDb: '线程库里的线程',
  threadsWithRollout: '有会话文件的线程',
  threadRolloutMissing: '会话文件已经不在的线程',
  threadRolloutOutsideRoots: '会话文件在不扫目录里的线程',
  threadRolloutNotInCensus: '会话文件没被清点到的线程',
  censusRolloutsNotInDb: '不在线程库里的会话文件',
  spawnEdges: '线程库里的派生关系',
  spawnEdgesChildInCensus: '子会话文件在本机的派生关系',
  spawnEdgesAttachedBySwob: 'Swob 已表达的派生关系',
  legacyUnits: '旧版目录里的会话',
  // ② content
  mainRead: '主会话 Swob 读入',
  mainLost: '主会话丢失',
  mainLostUser: '主会话丢失：你的消息',
  mainLostAssistant: '主会话丢失：助手回复',
  mainLostToolResult: '主会话丢失：工具结果',
  mainLostMeta: '主会话丢失：其他元数据',
  mainUnexplainedLost: '主会话丢失：原因未查明',
  mainParseTimeouts: '主会话读取超时',
  mainReadRate: '主会话读全率',
  subagentRead: '子 agent Swob 读入',
  subagentLost: '子 agent 丢失',
  subagentLostUser: '子 agent 丢失：你的消息',
  subagentLostAssistant: '子 agent 丢失：助手回复',
  subagentLostToolResult: '子 agent 丢失：工具结果',
  subagentLostMeta: '子 agent 丢失：其他元数据',
  subagentUnexplainedLost: '子 agent 丢失：原因未查明',
  subagentParseTimeouts: '子 agent 读取超时',
  subagentReadRate: '子 agent 读全率',
  read: 'Swob 读入',
  lost: '丢失',
  lostUser: '丢失：你的消息',
  lostAssistant: '丢失：助手回复',
  lostToolResult: '丢失：工具结果',
  lostMeta: '丢失：其他元数据',
  readRate: '读全率',
  // C1c: Codex read per file
  unexplainedLost: '丢失：原因未查明',
  readUnavailableFiles: '没拿到 Swob 读入数的文件',
  parseableCompared: '参与比对的记录',
  mainNonBlankLines: '主会话非空行',
  mainBadLines: '主会话里工具写坏的行',
  mainParseable: '主会话可解析记录',
  mainParseableCompared: '主会话参与比对的记录',
  mainLineSeparatorRecords: '主会话含行分隔符的记录',
  mainTruncatedTails: '主会话末行没写完的文件',
  subagentNonBlankLines: '子 agent 非空行',
  subagentBadLines: '子 agent 里工具写坏的行',
  subagentParseable: '子 agent 可解析记录',
  subagentParseableCompared: '子 agent 参与比对的记录',
  subagentLineSeparatorRecords: '子 agent 含行分隔符的记录',
  subagentTruncatedTails: '子 agent 末行没写完的文件',
  files: '文件',
  nonBlankLines: '非空行',
  badLines: '工具写坏的行',
  parseable: '可解析记录',
  lineSeparatorRecords: '含行分隔符的记录',
  truncatedTails: '末行没写完的文件',
  toolBadLines: '工具写坏的行（合计）',
  toolTruncatedTails: '末行没写完的文件（合计）',
  excludedChangedFiles: '运行中变化、没有参与比对的文件',
  // ③ compaction
  markerRows: '压缩标记行',
  compactSummaryRows: '压缩摘要行',
  subagentMarkerRows: '子 agent 里的压缩标记行',
  sessionsWithMarkers: '有压缩的会话',
  perSessionUniqueSum: '逐场去重后的压缩次数',
  globalUnique: '全局去重后的压缩次数',
  inheritedMarkers: '从父会话抄来的压缩标记',
  compactCount: 'Swob 认出的压缩次数',
  compactCountSum: 'Swob 认出的压缩次数',
  sessionsCompared: '参与比对的会话',
  sessionsEqual: '逐场一致的会话',
  sessionsMismatched: '压缩次数对不上的会话',
  sessionsExcludedChanged: '运行中变化、没有比对的会话',
  legacyCompactedRows: '旧格式压缩记录',
  compactionItemRows: '新格式压缩记录',
  contextCompactionEvents: 'ContextCompaction 事件',
  contextCompactedEvents: 'context_compacted 事件',
  subagentLegacyCompactedRows: '子 agent 里的旧格式压缩记录',
  subagentCompactionItemRows: '子 agent 里的新格式压缩记录',
  subagentInheritedMarkers: '子 agent 从父会话抄来的压缩标记',
  // C1c: files counted under the kernel's per-file rule (shown only when there are any)
  bothFormatFiles: '新旧两种压缩记录并存的文件',
  eventOnlyFiles: '只有压缩事件的文件',
  // ④ lineage
  derivationTotal: '线程库记录的派生边',
  derivationExpressed: '已表达的派生边',
  derivationNotExpressed: '未表达的派生边',
  derivationSwobExtra: 'Swob 多出的派生边',
  forkTotal: '顶层分叉边（forked_from_id）',
  forkExpressed: '已表达的分叉边',
  forkNotExpressed: '未表达的分叉边',
  forkSwobExtra: 'Swob 多出的分叉边',
  continuationTotal: '续写文件对',
  continuationExpressed: '已表达的续写边',
  continuationNotExpressed: '未表达的续写边',
  subagentTotal: '子 agent 边',
  subagentExpressed: '已表达的子 agent 边',
  subagentNotExpressed: '未表达的子 agent 边',
  resumeForkTotal: '恢复/分叉边（uuid 重叠 ≥8）',
  resumeForkExpressed: '已表达的恢复/分叉边',
  resumeForkNotExpressed: '未表达的恢复/分叉边',
  resumeForkSwobExtra: 'Swob 多出的恢复/分叉边',
  forkExplained: '已解释的分叉边（子会话无对话内容）',
  sameFileParentCoverage: '同文件父指针覆盖率',
  // ⑤ tokens (census-level evidence)
  forkUsageCopies: '子 agent 抄写父会话的用量快照',
  forkUsageCopiesSameTimestamp: '时间戳也相同的抄写快照',
  forkChildFilesWithCopies: '含抄写快照的子 agent 文件',
  // ⑤ tokens (C2a: the check itself)
  nonCachedInput: '非缓存输入',
  cacheRead: '缓存读',
  cacheWrite: '缓存写',
  output: '输出',
  reasoning: '推理',
  billingTotal: '计费合计',
  uniqueFacts: '去重后的用量事实',
  billingTotalDeviationPct: '计费合计偏差',
  nonCachedInputDeviationPct: '非缓存输入偏差',
  cacheReadDeviationPct: '缓存读偏差',
  cacheWriteDeviationPct: '缓存写偏差',
  outputDeviationPct: '输出偏差',
  reasoningDeviationPct: '推理偏差',
  // ⑤ tokens (C2a-2: branch-family grouping, Claude only — package decision E1/E2)
  sessionsRawCompared: '并组前的场次',
  maxBranchGroupSize: '本次最大分支组大小',
  // ⑥ resume (C2c)
  recoverable: '可恢复',
  missingFile: '缺文件',
  missingDirectory: '缺目录',
  unsupportedSource: '不支持来源（单场）',
  recoverableRate: '可恢复率',
  commandSampled: '命令层抽样场数',
  commandFound: '程序可找到',
  commandBrokenSymlink: '程序是坏链接',
  commandMissing: '程序找不到',
  commandSyntaxInvalid: '命令语法不对',
  anchorCompared: '参与锚点比对',
  anchorMatch: '锚点一致',
  anchorMismatch: '锚点不一致',
  // ⑥ resume (C2c-3)
  anchorCacheLag: '锚点缓存滞后',
  anchorCannotVerify: '锚点无法核对'
}

/** Headings, table headers and fixed sentences of the Markdown report. */
export const MARKDOWN_TEXT = {
  title: 'Swob 内核体检报告 · {date}',
  headGenerated: '生成于 {time}（{offset}）',
  headMachine: '机器：{model}',
  headMachineTag: '机器标签：{tag}',
  headKernel: '内核：swob {version} @{commit}',
  headReadOnly: '只读运行',
  headCheckup: '体检程序：checkup {version}',
  headSelfTest: '自检：{n}/{n}',
  headScopeAll: '范围：本机现存的全部原始数据',
  headScopeDay: '范围：{date} 当天有新消息的会话',
  headScopeRange: '范围：{date} 至 {date}',
  headDuration: '用时：约 {n} 秒',
  headLegend: '标签说明：[R] reported，原始记录直接数或直接加；[D] derived，按固定规则算出；[E] estimated，含推断；[U] unavailable，来源里没有这项数据（不是 0）。',
  overall: '总评：{verdict}',
  overallReason: '无法判定（{reason}）',
  overallCounts: '{n} 项检查里：不通过 {n} 项，注意 {n} 项，通过 {n} 项，不适用 {n} 项，无法判定 {n} 项。',
  adviceFail: '建议先处理：{checks}。',
  adviceWarn: '需要留意：{checks}。',
  advicePass: '已检查的各项都通过。',
  verdictWithReason: '{verdict}（{reason}）',
  checkHeading: '{check} — {verdict}',
  checkHeadingReason: '{check} — {verdict}（{reason}）',
  oracleLine: '标准答案：{oracles}。',
  unavailableCell: '—（{reason}）',
  unknownReason: '原因未登记',
  megabytes: '{n} MB',
  kilobytes: '{n} KB',
  sourcesLegend: '括号里是原因：未检查＝本版体检还没有检查这个来源；未实现＝本版还没有实现这项检查；无数据＝本机没有这个来源的数据；来源不提供＝这个来源本身不提供这项数据；只读不解析＝这类来源在只读模式下不解析；未选＝这次没有选这个来源。',
  timeSpan: '{date} ~ {date}',
  sessionsRatio: '{n}/{n} 场',
  lossKinds: '{kinds}',
  rowMain: '{source} 主会话',
  rowSubagent: '{source} 子 agent',
  colCheck: '检查项',
  colVerdict: '结论',
  colHeadline: '一句话',
  colAction: '你要做什么',
  colSource: '来源',
  colReadoutSessions: 'Swob 读到的会话',
  colUnits: '原始单元',
  colBecameSession: '成为会话',
  colMerged: '并入会话',
  colExcluded: '预期排除',
  colNotIncluded: '未纳入',
  colUnsupported: '不支持的格式',
  colChanged: '运行中变化',
  colInclusionRate: '纳入率',
  colNonBlank: '非空行',
  colToolBad: '工具写坏的行',
  colParseable: '可解析记录',
  colSwobRead: 'Swob 读入',
  colLost: '丢失',
  colLostKinds: '丢失里有什么',
  colReadRate: '读全率',
  colSessionsWithMarkers: '有压缩的会话',
  colPerSession: '原始压缩标记（逐场去重）',
  colGlobal: '全局去重',
  colSwobCompact: 'Swob 认出',
  colSessionsEqual: '逐场一致',
  colEdgeType: '边的类型',
  colEdgeTotal: '标准答案边数',
  colEdgeExpressed: '已表达',
  colEdgeNotExpressed: '未表达',
  colEdgeSwobExtra: 'Swob 多出[E]',
  // ⑤ tokens (C2a)
  colOracleBillingTotal: '标准答案计费合计',
  colSwobBillingTotal: 'Swob 计费合计',
  colDeviation: '偏差',
  // C2a-2 deliverable 1 (package decision E1): "其中 N 场按分支家族并为 M 组比对（最大组 K 场）。" — three
  // `{n}` in order (原始场次, 并组后条目, 本次最大组大小), same repeated-placeholder convention as sessionsRatio.
  tokensBranchGrouping: '其中 {n} 场按分支家族并为 {n} 组比对（最大组 {n} 场）。',
  // ⑥ resume (C2c)
  colResumeTotal: '会话数',
  colRecoverableRate: '可恢复率',
  colMissingFile: '缺文件',
  colMissingDirectory: '缺目录',
  colCommandSample: '命令层抽样（找到/坏链接/找不到）',
  colAnchor: '锚点（一致/不一致）',
  resumeCommandCell: '{n} 找到 / {n} 坏链接 / {n} 找不到',
  resumeAnchorCell: '{n} 一致 / {n} 不一致',
  // ⑥ resume (C2c-3, 抽样种子与抽中会话，工程师视图；task book H1 / C2c 独立验收 P2-1)
  resumeSamplingLine: '抽样种子：{date}（{offset}）· 抽中会话（盐化 id，至多 5 个）：{samples}',
  resumeSamplingLineEmpty: '抽样种子：{date}（{offset}）· 本次没有会话被抽中',
  colMeasure: '数字',
  colSide: '哪一侧',
  colUnit: '单位',
  sideSwob: 'Swob 侧',
  sideOracle: '标准答案侧',
  otherNumbers: '其他数字',
  sourcesHeading: '各来源一览',
  inventoryHeading: '附：原始数据盘点',
  colRoot: '位置',
  colPhysical: '物理单元',
  colBytes: '体积',
  colTimeSpan: '时间跨度',
  colScanned: 'Swob 是否读取',
  scannedYes: '读',
  scannedNo: '不读',
  inventoryEmptyRest: '其余 {n} 个来源位置本机没有数据。',
  sideEffectsHeading: '附：已知副作用',
  colEffect: '副作用',
  colCount: '数量',
  sideEffectsNone: '没有记录到副作用。',
  oraclesHeading: '附：本次用到的标准答案',
  colOracle: '标准答案',
  colStatus: '状态',
  oracleAvailable: '可用',
  oracleAvailableVersion: '可用（第 {n} 版）',
  oracleUnavailable: '不可用（{reason}）',
  libraryHeading: '附：桌面库同步（只影响桌面 app）',
  colItem: '项目',
  colValue: '数值',
  libraryPackages: '库里的会话包',
  libraryLastWrite: '最后一次写入',
  libraryMissingLive: '现存会话里不在库中的',
  libraryStaleLive: '库里版本比原始数据旧的',
  selfTestHeading: '附：自检明细（工程）',
  colSelfTestCase: '自检类别',
  colResult: '结果',
  diagnosticsHeading: '附：运行诊断（工程）',
  colDiagnostic: '诊断项',
  timingsHeading: '附：分段耗时（工程）',
  colPhase: '阶段',
  colMilliseconds: '毫秒',
  samplesLine: '样本：{samples}',
  measureWithKey: '{measure}（{key}）',
  // —— C1b-2 (acceptance P2-1, P2-8) ——
  overallSourceEmpty: '注意：{sources} 在本机有数据，但 Swob 这次一场会话都没读到。这不影响上面的结论，详见 ① 会话纳入。',
  readoutCellFlagged: '{n}（{verdict}）',
  sourcesLegendLegacy: '旧版目录＝问题只出在这个工具的旧版目录里（Kimi 是 ~/.kimi/sessions），与新版本身无关。',
  // —— C1c: a --sources report names what it checked ——
  headScopeSources: '范围：本次只体检 {sources}（其余 {n} 个来源未选）'
} as const

/** The AI-diary one-liner (design §五 "AI 日记每日摘要"); a [D] number is written with a leading 「≈」. */
export const DIGEST_TEXT = {
  lead: '体检',
  sessionsAll: '全部 {n} 场会话（{sourceCounts}）',
  sessionsDay: '今天 {n} 场会话（{sourceCounts}）',
  sessionsRange: '所选时段 {n} 场会话（{sourceCounts}）',
  sessionsAllBare: '全部 {n} 场会话',
  sessionsDayBare: '今天 {n} 场会话',
  sessionsRangeBare: '所选时段 {n} 场会话',
  sources: '{n} 个来源',
  sourceEmpty: '{sources}：一场会话都没读到（{verdict}）',
  allPass: '各项通过',
  checkedPass: '已检查的 {n} 项都通过',
  inclusionGaps: '纳入：{n} 个单元没挂上（{verdict}）',
  contentComplete: '记录读全',
  contentLost: '丢 {n} 条（{verdict}）',
  compaction: '压缩：原始 {n} 处，Swob 认出 {n} 处（{verdict}）',
  undetermined: '无法判定（{reason}）',
  noteReported: '数字均为 [R]',
  noteDerived: '≈ 为 [D]，其余为 [R]',
  link: '[[{link}]]',
  linkNoteReported: '[[{link}]]（数字均为 [R]）',
  linkNoteDerived: '[[{link}]]（≈ 为 [D]，其余为 [R]）',
  // C1b-2 (acceptance P2-3): one part per compaction source that is not passing
  compactionSource: '压缩：{source} 原始 {n} 处，Swob 认出 {n} 处（{verdict}）',
  // C1c: the lead of a --sources report (its counts cover the selected sources only)
  leadPartial: '体检（部分来源）',
  // C1d (C1c acceptance P2-2): the sessions of a --sources report of scope all never read 「全部」
  sessionsPartial: '所选来源 {n} 场会话（{sourceCounts}）',
  sessionsPartialBare: '所选来源 {n} 场会话',
  // C1d: ② passed while a measured source got no read count at all (its ② one-liner says the same)
  contentUnread: '{sources}：本轮未取得读数'
} as const

/** The 「和上次比」 line and section. */
export const COMPARE_TEXT = {
  none: '和上次比：没有找到可比的上次报告。',
  refused: '和上次比：{reason}，这次不比。',
  summary: '和上次比（上次 {date}）：新增问题 {n} 项，已修复 {n} 项，未变 {n} 项，首次检查 {n} 项。',
  heading: '和上次比',
  previousReport: '上次报告：{time}（{offset}）',
  verdicts: '总评：上次{verdict}，这次{verdict}',
  versionChanged: '两次的体检程序版本不同（上次 {version}，这次 {version}），部分差异可能来自体检本身的改动。',
  issueHeading: '问题级（全部六项）',
  unitHeading: '单元级（① ②，只比两次都在、内容没变的文件）',
  unitsUnavailable: '有一份报告没有逐单元结果，这次不做单元级比对。',
  groupAdded: '新增问题',
  groupFixed: '已修复',
  groupUnchanged: '未变',
  groupFirstCheck: '首次检查',
  groupNotChecked: '本次未检查',
  unitsCompared: '参与比对的单元',
  unitsNewOrChanged: '本次新增或内容有变化的单元',
  unitsGone: '已不在的单元',
  unitsChangedDuringRun: '体检期间在变化、没有比对的单元',
  unitsSourceNotInBoth: '只有一次检查过的来源里的单元',
  problemInclusion: '未纳入或格式不支持',
  problemContent: '读入数和原始记录对不上',
  colGroup: '分组',
  colCount: '数量',
  colUnitCount: '单元数',
  colProblem: '问题',
  colReason: '原因',
  colPrevious: '上次',
  colCurrent: '这次',
  colDelta: '变化',
  colSamples: '样本',
  // C1b-2 (acceptance P2-13): the summary line when previous issues were not checked this time
  summaryWithNotChecked: '和上次比（上次 {date}）：新增问题 {n} 项，已修复 {n} 项，未变 {n} 项，首次检查 {n} 项，本次未检查 {n} 项。',
  // C2b: a check that moved from undetermined (check.not-implemented) to a real verdict is never counted
  // as a new problem (checkLooked/compareIssues already send it to firstCheck); this names the transition.
  // (C2a independently added the same sentence under a second key, `newlyDetermined`, for the same
  // transition; the merge kept this one — see render-markdown.ts#overallLines — and retired that one.)
  newlyImplementedChecks: '本次新增了 {checks} 的判定。'
} as const

let cachedTemplateSet: Set<string> | null = null

/** Every registered sentence (with `{source}` expanded), digit-normalised. */
export function registeredTemplateSet(): Set<string> {
  if (cachedTemplateSet) return cachedTemplateSet
  const raw: string[] = [
    ...Object.values(HEADLINES),
    ...Object.values(OWNER_ACTIONS),
    ...GENERIC_TEMPLATES,
    ...Object.values(FINDING_TEXT).flatMap((entry) => entry ? [entry.ownerLine, entry.engineerHint] : []),
    // C1d: sentences older reports may still carry
    ...RETIRED_TEMPLATES.map((entry) => entry.text),
    // C1b registries
    ...Object.values(VERDICT_LABELS),
    ...Object.values(CHECK_LABELS),
    ...Object.values(CHECK_SHORT_LABELS),
    ...Object.values(REASON_TEXT),
    ...Object.values(REASON_SHORT_TEXT).filter((text): text is string => !!text),
    ...Object.values(UNIT_LABELS),
    ...Object.values(LINEAGE_EDGE_LABELS),
    ...Object.values(ORACLE_LABELS),
    ...Object.values(LOSS_KIND_LABELS),
    ...Object.values(MEASURE_LABELS),
    ...Object.values(MARKDOWN_TEXT),
    ...Object.values(DIGEST_TEXT),
    ...Object.values(COMPARE_TEXT)
  ]
  const set = new Set<string>()
  for (const template of raw) {
    if (template.includes('{source}')) {
      for (const label of Object.values(SOURCE_LABELS)) set.add(normalizeTemplateText(template.replace(/\{source\}/g, label)))
    } else {
      set.add(normalizeTemplateText(template))
    }
  }
  cachedTemplateSet = set
  return set
}
