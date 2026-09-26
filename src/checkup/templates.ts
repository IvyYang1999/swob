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
  'check.not-implemented': '本版体检还没有实现这一项',
  'check.undetermined': '本项这次无法判定',
  'check.not-applicable': '本项对本机数据不适用'
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
    ownerLine: '{source}：有 {n} 条记录没读进来，其中 {n} 条是你本人发的消息。原因是记录里有特殊的「行分隔符」，Swob 把一条记录切成两半后悄悄丢掉了',
    engineerHint: 'src/main/session-loader.ts#parseSessionFile / src/main/codex-loader.ts#parseCodexFile：readline 把 U+2028/U+2029 当换行'
  },
  'content.unexplained-loss': {
    ownerLine: '{source}：有 {n} 条记录没读进来，原因还没查明',
    engineerHint: 'src/main/session-loader.ts#parseSessionFile：逐文件读入数少于规范读法且无行分隔符可解释'
  },
  'content.swob-extra-records': {
    ownerLine: '{source}：有 {n} 个文件 Swob 读出的记录比原始记录还多，原因还没查明',
    engineerHint: 'src/main/session-loader.ts#parseSessionFile：读入数多于规范读法'
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
    engineerHint: 'src/main/session-loader.ts#parseSessionFile：30 秒超时后静默截断，或读取抛错'
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
    engineerHint: 'src/main/codex-loader.ts#codexToRawMessages：行类型联合里没有 compacted，只认 compaction 与 *compact* 事件'
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
    engineerHint: 'src/main/session-loader.ts#loadLegacySessionSnapshot：子 agent 只挂顶层父会话，没按 thread_spawn 逐级上溯'
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
  }
}

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
// {check}/{checks} check names · {verdict} verdict word · {reason} reason text ·
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
  'content.line-separator-split': '记录里的特殊行分隔符让 Swob 把记录切断后丢掉',
  'content.tool-bad-line': '工具自己写坏的行',
  'content.truncated-tail': '文件最后一行没写完整',
  'content.unexplained-loss': '记录没读进来，原因还没查明',
  'content.swob-extra-records': 'Swob 读出的记录比原始记录还多',
  'content.swob-per-file-unavailable': 'Swob 没有按文件给出读入数',
  'codex.legacy-compacted-unrecognized': 'Swob 不认旧格式的压缩记录',
  'compaction.count-mismatch': '压缩次数和原始记录对不上',
  'compaction.fork-inherited-marker': '恢复或分叉时从父会话抄来的压缩标记',
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
  'codex.fork-usage-copy': '子 agent 抄写了父会话的用量快照',
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
  'checkup.scope-not-implemented': '范围未实现'
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

/** Oracle ids (contract ORACLE_IDS). */
export const ORACLE_LABELS: Readonly<Record<string, string>> = {
  'census.claude-jsonl': 'Claude Code 原始文件逐行重读',
  'census.codex-jsonl': 'Codex 原始文件逐行重读',
  'codex.state-db': 'Codex 线程库',
  'census.unscanned-roots': 'Swob 不读的已知目录清点',
  'census.source-presence': '各来源目录是否存在'
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
  // ⑤ tokens (census-level evidence)
  forkUsageCopies: '子 agent 抄写父会话的用量快照',
  forkUsageCopiesSameTimestamp: '时间戳也相同的抄写快照',
  forkChildFilesWithCopies: '含抄写快照的子 agent 文件'
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
  measureWithKey: '{measure}（{key}）'
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
  linkNoteDerived: '[[{link}]]（≈ 为 [D]，其余为 [R]）'
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
  groupNotChecked: '这次没能检查',
  unitsCompared: '参与比对的单元',
  unitsNewOrChanged: '本次新增或内容有变化的单元',
  unitsGone: '已不在的单元',
  unitsChangedDuringRun: '体检期间在变化、没有比对的单元',
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
  colSamples: '样本'
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
    // C1b registries
    ...Object.values(VERDICT_LABELS),
    ...Object.values(CHECK_LABELS),
    ...Object.values(CHECK_SHORT_LABELS),
    ...Object.values(REASON_TEXT),
    ...Object.values(REASON_SHORT_TEXT).filter((text): text is string => !!text),
    ...Object.values(UNIT_LABELS),
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
