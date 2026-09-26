/**
 * Registry of every sentence a report may contain. The privacy scanner only
 * accepts prose that equals one of these templates after numbers are
 * normalised, so new wording must be added here first.
 *
 * Placeholders: `{n}` → a number; `{source}` → a source display label.
 */
import type { ReasonCode, Verdict } from './contract'

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
    ownerLine: '{source}：原始文件里有 {n} 行被工具自己写坏了，这不是 Swob 的问题，照样列出',
    engineerHint: 'census/jsonl-census.ts：JSON.parse 失败的非空行（只按换行符分行）'
  },
  'content.truncated-tail': {
    ownerLine: '{source}：有 {n} 个文件的最后一行没写完整，多半是工具写到一半被打断',
    engineerHint: 'census/jsonl-census.ts：末行无换行符且无法解析'
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

let cachedTemplateSet: Set<string> | null = null

/** Every registered sentence (with `{source}` expanded), digit-normalised. */
export function registeredTemplateSet(): Set<string> {
  if (cachedTemplateSet) return cachedTemplateSet
  const raw: string[] = [
    ...Object.values(HEADLINES),
    ...Object.values(OWNER_ACTIONS),
    ...GENERIC_TEMPLATES,
    ...Object.values(FINDING_TEXT).flatMap((entry) => entry ? [entry.ownerLine, entry.engineerHint] : [])
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
