#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const defaultOutputDir = path.join(repoRoot, 'dist', 'website-docs')

const sourceFiles = {
  accounting: 'src/main/token-accounting.ts',
  audit: 'src/main/session-audit.ts',
  valuation: 'src/main/token-valuation.ts',
  pricingCatalog: 'src/main/pricing-catalog.ts',
  cli: 'src/cli/command-registry.ts',
  recovery: 'src/main/recovery-failure-message.ts',
  recoveryMetrics: 'src/main/recovery-metrics.ts',
  windowsAlpha: 'docs/windows-alpha.md'
}

function readSource(name) {
  return fs.readFileSync(path.join(repoRoot, sourceFiles[name]), 'utf8')
}

/** Extract a balanced TS object/array/interface without executing project code. */
export function extractBalanced(source, marker, open, close) {
  const markerIndex = source.indexOf(marker)
  if (markerIndex < 0) throw new Error(`找不到源码标记：${marker}`)
  const start = source.indexOf(open, markerIndex)
  if (start < 0) throw new Error(`标记 ${marker} 后找不到 ${open}`)
  let depth = 0
  let quote = ''
  let escaped = false
  let lineComment = false
  let blockComment = false
  for (let index = start; index < source.length; index++) {
    const char = source[index]
    const next = source[index + 1]
    if (lineComment) {
      if (char === '\n') lineComment = false
      continue
    }
    if (blockComment) {
      if (char === '*' && next === '/') {
        blockComment = false
        index++
      }
      continue
    }
    if (quote) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === quote) quote = ''
      continue
    }
    if (char === '/' && next === '/') {
      lineComment = true
      index++
      continue
    }
    if (char === '/' && next === '*') {
      blockComment = true
      index++
      continue
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char
      continue
    }
    if (char === open) depth++
    if (char === close) {
      depth--
      if (depth === 0) return source.slice(start, index + 1)
    }
  }
  throw new Error(`源码标记 ${marker} 的 ${open}${close} 未闭合`)
}

export function interfaceFields(source, interfaceName) {
  const block = extractBalanced(source, `export interface ${interfaceName}`, '{', '}')
  const fields = []
  let depth = 1
  for (const line of block.slice(1, -1).split('\n')) {
    if (depth === 1) {
      const match = line.match(/^\s*([A-Za-z_$][\w$]*)\??\s*:/)
      if (match) fields.push(match[1])
    }
    const structural = line
      .replace(/\/\/.*$/, '')
      .replace(/'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`/g, '')
    depth += [...structural].filter((char) => char === '{').length
    depth -= [...structural].filter((char) => char === '}').length
  }
  return fields
}

function literalFromSource(source, marker, open, close) {
  const markerIndex = source.indexOf(marker)
  if (markerIndex < 0) throw new Error(`找不到源码标记：${marker}`)
  const assignmentIndex = source.indexOf('=', markerIndex)
  if (assignmentIndex < 0) throw new Error(`源码标记 ${marker} 后找不到赋值号`)
  const literal = extractBalanced(source.slice(assignmentIndex + 1), '', open, close)
  return vm.runInNewContext(`(${literal})`, Object.create(null), { timeout: 100 })
}

function kebab(value) {
  return value.replace(/([a-z0-9])([A-Z])/g, '$1-$2').replace(/_/g, '-').toLowerCase()
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function stringUnionValues(source, typeName) {
  const line = source.match(new RegExp(`export type ${typeName} = ([^\\n]+)`))?.[1] || ''
  return [...line.matchAll(/'([^']+)'/g)].map((match) => match[1])
}

const componentDocs = {
  nonCachedInputTokens: {
    anchor: 'non-cached-input', title: '非缓存输入 Token', status: '已实现',
    definition: '本次调用中没有命中输入缓存的输入 token。它与 cache read、cache write、output 四桶互斥。',
    source: 'Claude 读取 usage.input_tokens；Codex 用 inputTokens − cachedInputTokens，并把结果截到不小于 0。',
    formula: 'max(0, input − cached input)。Claude 的 input_tokens 已作为非缓存输入直接记录。',
    limits: '不同提供商的 usage schema 不同；来源未验证时整组 token 会标为 unavailable，不会猜成 0。',
    surfaces: 'Insights 总览、成本与缓存页、会话明细。'
  },
  cacheReadTokens: {
    anchor: 'cache-read', title: 'Cache read Token', status: '已实现',
    definition: '由提供商报告、从已有 prompt cache 读取的输入 token。',
    source: 'Claude 的 cache_read_input_tokens；Codex 的 cachedInputTokens。',
    formula: '逐个去重后的 usage event 相加；Codex 会限制 cachedInputTokens ≤ inputTokens。',
    limits: '“命中缓存”不等于免费；真实折扣取决于提供商、模型与合同。',
    surfaces: 'Insights 的 token 分桶、缓存效率与会话明细。'
  },
  cacheWriteTokens: {
    anchor: 'cache-write', title: 'Cache write（TTL 未知）', status: '已实现',
    definition: '写入或创建 prompt cache、但来源没有提供 TTL 拆分的输入 token。',
    source: 'Claude 只有 cache_creation_input_tokens 且没有 5m/1h breakdown 时记录；Codex 的 cacheWriteTokens 也进入此桶。',
    formula: '逐个去重后的 usage event 相加；一旦 Claude 提供 TTL breakdown，聚合桶归零，改入 5m/1h 两桶，避免重复。',
    limits: 'TTL 未知时不能套用 Anthropic 的 5 分钟或 1 小时写入价，因此估值可能保持 unpriced。',
    surfaces: 'Insights 的 token 分桶、缓存效率与会话明细。'
  },
  cacheWrite5mTokens: {
    anchor: 'cache-write-5m', title: 'Cache write 5m Token', status: '条件可用',
    definition: '明确标记为 5 分钟 TTL 的 prompt cache 写入 token。',
    source: 'Claude usage.cache_creation.ephemeral_5m_input_tokens。',
    formula: '逐个去重后的 usage event 相加，并与 TTL 未知/1h 桶保持互斥。',
    limits: '只有来源持久化 TTL breakdown 时可用；聚合字段与 breakdown 不闭合会产生 warning。',
    surfaces: 'Insights 缓存拆分、成本与定价追溯。'
  },
  cacheWrite1hTokens: {
    anchor: 'cache-write-1h', title: 'Cache write 1h Token', status: '条件可用',
    definition: '明确标记为 1 小时 TTL 的 prompt cache 写入 token。',
    source: 'Claude usage.cache_creation.ephemeral_1h_input_tokens。',
    formula: '逐个去重后的 usage event 相加，并与 TTL 未知/5m 桶保持互斥。',
    limits: '只有来源持久化 TTL breakdown 时可用；缺失不等于没有 1h cache。',
    surfaces: 'Insights 缓存拆分、成本与定价追溯。'
  },
  outputTokens: {
    anchor: 'output', title: '输出 Token', status: '已实现',
    definition: '模型输出 token 总量；如果提供商把 reasoning 作为输出子集报告，这里已经包含它。',
    source: 'Claude 的 output_tokens；Codex 的 outputTokens。',
    formula: '逐个去重后的 usage event 相加。reasoning 不会再加一次。',
    limits: '不同提供商对隐藏 reasoning 的可见性不同，不能跨来源假设完全同质。',
    surfaces: 'Insights 总览、成本与缓存页、会话明细。'
  },
  reasoningTokens: {
    anchor: 'reasoning', title: 'Reasoning Token', status: '条件可用',
    definition: '提供商单独报告的 reasoning token 元数据；在 Swob 当前口径里它属于 output 的子集。',
    source: '当前由 Codex reasoningTokens 提供；Claude Code 本地 usage 未统一提供独立桶。',
    formula: 'min(outputTokens, reported reasoningTokens)；仅作拆分观察，不计入 processed total 的额外加项。',
    limits: '不是“思考质量”，也不能与 Session Audit 的 thinking block 指标互换。',
    surfaces: '支持该字段的会话 token 明细；无来源证据时不展示为 0。'
  }
}

const accountingDocs = [
  {
    anchor: 'input-plus-output', title: 'input_plus_output', status: 'CLI 契约',
    definition: '面向 CLI Insights 的窄口径：输入与输出之和，不含 cache creation/read。',
    source: 'CLI command registry 与生成的 /swob skill 共同声明该机器接口契约。',
    formula: 'inputTokens + outputTokens。',
    limits: '不能当作账单 token，也不能和 billing total 直接比较；两者是否包含缓存桶不同。',
    surfaces: 'swob insights 的 JSON/summary 输出。'
  },
  {
    anchor: 'billing-total', title: 'Processed / billing total', status: '已实现',
    definition: '提供商 usage 事件经去重后，被处理的输入、缓存读写与输出总和。',
    source: 'NormalizedTokenComponents 与每个 provider 的 usage event。',
    formula: '非缓存输入 + cache read + cache write(TTL 未知 + 5m + 1h) + output；reasoning 不重复相加。',
    limits: '“billing”描述处理范围，不代表已付账单；价格、折扣和合同不在这个数里。',
    surfaces: 'Insights 总览与全局 token 汇总。'
  },
  {
    anchor: 'conversation-only', title: 'Conversation only', status: '已实现',
    definition: '只统计主对话 scope 的 processed total。',
    source: 'usageEvents 中 scope === main 的事件。',
    formula: '先过滤主线程事件，再按 billing total 的四桶公式求和。',
    limits: '会排除 sidechain、subagent、继承视图；不同 harness 对 scope 的记录能力不同。',
    surfaces: 'Insights 的 conversation 范围筛选与会话分析。'
  },
  {
    anchor: 'token-provenance', title: 'Token 数据来源标记', status: '已实现',
    definition: '说明 token 是 reported、derived、estimated，还是 unavailable。',
    source: '每个 TokenAccounting 与 UsageEvent 的 provenance 字段。',
    formula: '原始 usage 为 reported；累计计数做差为 derived；当前无可靠 schema 为 unavailable。',
    limits: '来源标记说明证据链，不代表 reported 数据绝对无误。',
    surfaces: 'Insights 数据质量提示与 Session Audit 证据标记。'
  },
  {
    anchor: 'api-equivalent-usd', title: 'API 等价值（估算）', status: '已实现 · Valuation v1',
    definition: '把已覆盖的 token 按对应模型公开 API 单价折算的比较值；界面总额保留底层 mode 明细，不等于用户实际支出。',
    source: '逐请求 UsageEvent 的模型、billing provider、事件时间、缓存 TTL 与内置版本化官方价格快照；日志自带金额优先。',
    formula: '每个可定价桶按百万 token 单价与可验证的长上下文倍数计算，再按去重事件求和。',
    limits: '不等于订阅现金支出；batch、非标准 service tier/speed、区域价或请求级模型证据不足时保守 unpriced。',
    surfaces: 'Insights 总览、成本与缓存、数据质量、会话排名、Audit Report 与 Session Audit。'
  },
  {
    anchor: 'valuation-modes', title: '金额 mode（来源语义）', status: '已实现 · 4 种',
    definition: 'reported 是日志自带金额；estimated-list-price 是显式 provider 的精确目录估算；api-equivalent 是从模型推断原厂后的等价估算；unpriced 表示不能可靠定价。',
    source: 'Valuation.mode、UsageEvent.reportedCostUsd 与 providerProvenance。',
    formula: '日志金额优先；否则只有请求级模型、provider、时间和计价修饰符都满足保守门槛时才查价格目录。',
    limits: 'reported 只表示来源日志报告，并不自动等于信用卡账单；混合聚合必须继续展示 modeBreakdown。',
    surfaces: 'Insights 定价追溯、Audit Report 与 Session Audit 估值证据。'
  },
  {
    anchor: 'valuation-coverage', title: '估值覆盖率', status: '已实现 · Valuation v1',
    definition: '有可靠价格匹配的 token，占有可靠 token 数据总量的比例。',
    source: '每个 Valuation 的 coveredTokens 与 totalBillableTokens，跨去重事件聚合。',
    formula: 'coveredTokens ÷ totalBillableTokens × 100；无 billable token 时，有金额证据为 100，否则为 0。',
    limits: '高覆盖率只表示更多 token 找到价格，不表示价格等于账单；必须与金额 mode、missing reasons 和分析范围同屏。',
    surfaces: 'Insights 数据质量、成本卡、会话排名与 Audit Report。'
  },
  {
    anchor: 'unavailable', title: 'unavailable', status: '已实现',
    definition: '没有足够、可靠的来源数据，不能计算该数字。',
    source: 'TokenAccounting.provenance === unavailable，并附 unavailableReason。',
    formula: '总量与 components 均为 null；聚合时排除，绝不把它补成 0。',
    limits: '“不可用”不代表实际使用量为零，也不代表会话坏了。',
    surfaces: 'Insights 汇总、数据质量提示、来源能力说明。'
  },
  {
    anchor: 'unpriced', title: 'unpriced', status: '已实现 · Valuation v1',
    definition: 'token 数量可用，但缺少足够精确的价格匹配，所以无法折算价值。',
    source: 'Valuation 的 unpriced mode 与 missingReasons；常见原因是模型/provider/时间缺失、目录无规则或计价修饰符未建模。',
    formula: 'usd 保持 undefined；未覆盖量取 totalBillableTokens 与 coveredTokens 的差，不以 0 美元混入金额。',
    limits: 'unpriced 与 token unavailable 是两个不同失败层；部分覆盖时总金额只代表已定价部分。',
    surfaces: 'Insights 成本卡、定价追溯、数据质量、报告与会话排名。'
  },
  {
    anchor: 'recovery-success-rate', title: '复活成功率', status: '已实现',
    definition: '本机 Swob 实际执行过的恢复尝试中，结果 ok 的比例。',
    source: 'Vault 根目录的隐私最小化 append-only 恢复尝试日志；不记录路径和诊断正文。',
    formula: 'successes ÷ attempts；source-present、already-present、restored 都算成功，failed 算失败。',
    limits: '它不是所有会话“可恢复率”；0 次尝试时底层值为 0，界面必须同时看 attempts=0，不能解读为 0% 成功。',
    surfaces: 'Resume Audit / 恢复质量统计。'
  }
]

const auditDocs = {
  readEditRatio: ['Read / Edit 比', '读取工具次数 ÷ 编辑与写入工具次数。', '工具调用记录。', 'edits > 0 时 reads / edits；只有 reads 时取 reads；都没有时为 0。', '阈值未经验证，不能当成生产力或代码质量结论。', 'Session Audit 指标卡。'],
  readEditHealth: ['Read / Edit 健康带', '把 Read/Edit 比映射为 healthy、degraded、critical 或 unavailable。', 'readEditRatio 与是否观察到读写工具。', '≥6 healthy；≥2 degraded；其余 critical；无读写为 unavailable。', '实验启发式，明确不进入健康分。', 'Session Audit 发现与指标卡。'],
  thinkingDepth: ['Thinking block 形态', '统计 thinking/signature block 的数量、签名/正文平均长度与脱敏数。', '转录中的 thinking block 形态。', '对可见 block 求数量和长度均值。', '只能说明记录形态，不能衡量推理深度或质量。', 'Session Audit 指标卡。'],
  turnLatencies: ['相邻消息延迟', '相邻消息时间戳之差组成的逐轮序列。', '主线程用户/助手消息时间戳。', '只保留 0 到 1 小时内的正差。', '混合了排队、网络、工具和用户思考时间。', 'Session Audit 延迟明细。'],
  latencyStats: ['响应延迟 P50 / P95 / Max', '助手消息相对前一条消息的延迟分布。', '相邻消息延迟中的 assistant 项。', '排序后取 nearest-rank P50/P95 与最大值。', '不是端到端模型服务延迟，时间戳缺失时 unavailable。', 'Session Audit 指标卡与 findings。'],
  valuation: ['Session Audit 逐请求估值', '把会话 TokenAccounting 交给统一 Valuation 引擎，返回金额、mode、覆盖率、缺失原因与价格追溯。', '去重 UsageEvent 与内置版本化价格目录。', '逐请求按模型、provider、事件时间、缓存 TTL 和可验证的长上下文规则定价，再聚合。', 'API 等价值不是现金账单；无法精确匹配的请求保持 unpriced，不使用回退价。', 'Session Audit 估值卡与模型分布。'],
  visibleFrameworkMarkers: ['可见框架标记占比', '只估算用户消息中可见的框架标签文本及其占可见用户文本的比例。', '转录里实际可见的 framework marker。', '字符数 ÷ 4 估 token，再除以同法估算的可见用户文本 token。', '绝不是隐藏 API context overhead，也不是 provider token attribution。', 'Session Audit 框架标记卡。'],
  sessionType: ['会话类型', '按工具调用组合分类 coding/research/debugging/discussion/mixed。', '主线程工具调用计数与 Bash 错误。', '无工具为 discussion；编辑、搜索、报错 Bash、读取超过各自阈值时依次分类。', '代理分类且有顺序偏差，不是用户意图的事实标签。', 'Session Audit 概览。'],
  modelUsage: ['模型使用分布', '按模型汇总 assistant turn、input/output token 与静态估算成本。', 'assistant 消息 model 和 usage。', '按 model 分组求和并按 turns 降序。', '模型名和 usage 缺失会造成不完整；成本不是账单。', 'Session Audit 模型分布。'],
  toolEfficiency: ['工具效率', '对调用至少两次的工具统计次数、错误率和平均可观测延迟。', 'tool_use 与匹配的 tool_result。', 'errorRate = errorCount / count；平均延迟只使用可配对时间戳。', '缺失结果或时间戳不会被臆测；“效率”只是行为信号。', 'Session Audit 工具表。'],
  userInterruptions: ['用户中断数', '转录中命中中断标记的用户消息数量。', '可见用户文本中的 [Request interrupted 标记。', '逐条匹配并计数。', '依赖 harness 的持久化格式，未记录不代表没有中断。', 'Session Audit 交互指标。'],
  avgTurnsPerGoal: ['每个目标平均轮数', '用可见用户消息数近似目标数，再计算平均轮数。', '主线程时间戳消息与用户消息计数。', 'turnIndex ÷ user message count；无用户消息时取 turnIndex。', '一条用户消息不一定等于一个目标，名称是启发式代理。', 'Session Audit 交互指标。'],
  antiPatterns: ['工具反模式信号', '检测重复读取和连续重编辑等工具行为模式。', '工具名、路径与 turn index。', '超过动态阈值的重复 Read，或相邻 Edit/Write 命中同一路径。', '可能是合理工作流；仅供调查，不能单独判错。', 'Session Audit findings 与证据列表。'],
  frustrationSignals: ['可能的挫败信号', '检测快速短纠正、关键词、重复指令和中断。', '可见用户文本与时间戳。', '基于固定中英文关键词和时间/重复规则。', '语言、语气和上下文会产生误报与漏报。', 'Session Audit findings 与证据列表。'],
  healthScore: ['会话健康分', '从 80 分基线按已触发的实验因子扣分，再限制在 0–100。', 'frustration、anti-pattern、redacted thinking 三类 scoreFactors。', '80 + impacts；当前 Read/Edit 健康带不扣分。', '未经验证的透明启发式，不是客观质量评分。', 'Session Audit 顶部总览。'],
  healthLabel: ['会话健康标签', '把健康分映射为 excellent/good/fair/poor。', 'healthScore。', '≥80 excellent；≥60 good；≥40 fair；否则 poor。', '继承健康分的全部实验性局限。', 'Session Audit 顶部总览。'],
  scoreFactors: ['健康分因子', '列出每个加减分原因、影响值和行级证据。', '审计规则命中结果。', '当前只生成扣分项并对 impact 求和。', '规则集会随 methodologyVersion 演进；跨版本不宜直接排名。', 'Session Audit 分数解释。'],
  findings: ['审计发现', '把达到提示阈值的指标转成可读调查线索。', 'Read/Edit、挫败、反模式、脱敏 thinking、P95 延迟。', '按固定条件生成字符串列表。', '是线索摘要，不是新的独立测量，也不应脱离证据阅读。', 'Session Audit findings。']
}

const auditMetadataFields = new Set(['sessionId', 'experimental', 'methodologyVersion', 'readEditHealthBasis', 'limitations'])

export function collectTruth(sources = {}) {
  const accountingSource = sources.accounting ?? readSource('accounting')
  const auditSource = sources.audit ?? readSource('audit')
  const valuationSource = sources.valuation ?? readSource('valuation')
  const cliSource = sources.cli ?? readSource('cli')
  const recoverySource = sources.recovery ?? readSource('recovery')
  const componentFields = interfaceFields(accountingSource, 'NormalizedTokenComponents')
  const accountingFields = interfaceFields(accountingSource, 'TokenAccounting')
  const auditFields = interfaceFields(auditSource, 'SessionAuditResult')
  const valuationFields = interfaceFields(valuationSource, 'Valuation')
  const valuationModes = stringUnionValues(valuationSource, 'ValuationMode')
  const cliCommands = literalFromSource(cliSource, 'export const CLI_COMMANDS', '[', ']')
  const cliExitCodes = literalFromSource(cliSource, 'export const CLI_EXIT_CODES', '[', ']')
  const cliVersion = cliSource.match(/export const CLI_VERSION = '([^']+)'/)?.[1]
  const recoveryMessages = literalFromSource(recoverySource, 'const RECOVERY_FAILURE_MESSAGES', '{', '}')
  return { componentFields, accountingFields, auditFields, valuationFields, valuationModes, cliCommands, cliExitCodes, cliVersion, recoveryMessages }
}

export function validateTruth(truth) {
  const missingComponentDocs = truth.componentFields.filter((field) => !componentDocs[field])
  const staleComponentDocs = Object.keys(componentDocs).filter((field) => !truth.componentFields.includes(field))
  const codeAuditFields = truth.auditFields.filter((field) => !auditMetadataFields.has(field))
  const missingAuditDocs = codeAuditFields.filter((field) => !auditDocs[field])
  const staleAuditDocs = Object.keys(auditDocs).filter((field) => !codeAuditFields.includes(field))
  const requiredTotals = ['billingTotal', 'conversationOnly', 'provenance', 'unavailableReason']
  const missingAccountingFields = requiredTotals.filter((field) => !truth.accountingFields.includes(field))
  const requiredValuationFields = ['usd', 'mode', 'pricingMatch', 'coveredTokens', 'totalBillableTokens', 'coveragePercent', 'missingReasons', 'pricingRules', 'modeBreakdown', 'componentUsd']
  const missingValuationFields = requiredValuationFields.filter((field) => !truth.valuationFields.includes(field))
  const documentedValuationModes = ['reported', 'estimated-list-price', 'api-equivalent', 'unpriced']
  const valuationModeDrift = truth.valuationModes.filter((mode) => !documentedValuationModes.includes(mode))
  const missingValuationModes = documentedValuationModes.filter((mode) => !truth.valuationModes.includes(mode))
  const problems = [
    missingComponentDocs.length && `新增 token 桶缺少文档：${missingComponentDocs.join(', ')}`,
    staleComponentDocs.length && `token 文档已无对应代码字段：${staleComponentDocs.join(', ')}`,
    missingAuditDocs.length && `新增 Session Audit 字段缺少文档：${missingAuditDocs.join(', ')}`,
    staleAuditDocs.length && `Audit 文档已无对应代码字段：${staleAuditDocs.join(', ')}`,
    missingAccountingFields.length && `TokenAccounting 关键字段消失：${missingAccountingFields.join(', ')}`,
    missingValuationFields.length && `Valuation 关键字段消失：${missingValuationFields.join(', ')}`,
    valuationModeDrift.length && `新增 Valuation mode 缺少文档：${valuationModeDrift.join(', ')}`,
    missingValuationModes.length && `文档中的 Valuation mode 已无代码对应：${missingValuationModes.join(', ')}`,
    !truth.cliVersion && '无法读取 CLI_VERSION',
    !Array.isArray(truth.cliCommands) && '无法读取 CLI_COMMANDS',
    Object.keys(truth.recoveryMessages).length === 0 && '恢复失败原因表为空'
  ].filter(Boolean)
  if (problems.length) throw new Error(`文档真相源校验失败：\n- ${problems.join('\n- ')}`)
}

function metricCard(metric, extraClass = '') {
  return `<article class="metric-card ${extraClass}" id="${metric.anchor}">
    <header><div><span class="metric-status">${escapeHtml(metric.status || '实验')}</span><h3>${escapeHtml(metric.title)}</h3></div><a class="anchor-link" href="#${metric.anchor}" aria-label="链接到 ${escapeHtml(metric.title)}">#</a></header>
    <dl>
      <div><dt>定义</dt><dd>${escapeHtml(metric.definition)}</dd></div>
      <div><dt>数据来源</dt><dd>${escapeHtml(metric.source)}</dd></div>
      <div><dt>计算方式</dt><dd>${escapeHtml(metric.formula)}</dd></div>
      <div><dt>已知局限</dt><dd>${escapeHtml(metric.limits)}</dd></div>
      <div><dt>出现位置</dt><dd>${escapeHtml(metric.surfaces)}</dd></div>
    </dl>
  </article>`
}

function auditMetric(field) {
  const [title, definition, source, formula, limits, surfaces] = auditDocs[field]
  return { anchor: `audit-${kebab(field)}`, title, status: '实验 · experimental-v2', definition, source, formula, limits, surfaces }
}

function docsNavigation(root) {
  return `<nav class="chapter-nav" aria-label="文档章节">
    <a href="${root}/index.html"><span>01</span>快速上手</a>
    <a href="${root}/concepts/vault.html"><span>02</span>核心概念</a>
    <a href="${root}/metrics.html"><span>03</span>统计口径</a>
    <a href="${root}/guides/resume.html"><span>04</span>功能手册</a>
    <a href="${root}/troubleshooting.html"><span>05</span>FAQ 与排障</a>
  </nav>`
}

function page({ title, description, root = '.', site = '..', active = '', content, english = false }) {
  const body = content.replaceAll('{{root}}', root).replaceAll('{{site}}', site)
  const navigation = docsNavigation(root)
  return `<!doctype html>
<html lang="${english ? 'en' : 'zh-CN'}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
${english ? '  <meta name="robots" content="noindex, follow">\n' : ''}  <title>${escapeHtml(title)} · Swob Docs</title>
  <meta name="description" content="${escapeHtml(description)}">
  <meta name="theme-color" content="#efebe2">
  <link rel="icon" href="${site}/assets/favicon.svg" type="image/svg+xml">
  <link rel="stylesheet" href="${root}/assets/docs.css">
</head>
<body data-section="${escapeHtml(active)}">
  <a class="skip-link" href="#content">跳到正文</a>
  <header class="docs-header">
    <a class="docs-brand" href="${site}/zh/"><img src="${site}/assets/favicon.svg" width="28" height="28" alt=""><span>swob</span><em>docs</em></a>
    <nav aria-label="文档工具"><a href="${site}/zh/">官网</a><a href="${root}/en/index.html" lang="en">EN structure</a><a class="github-link" href="https://github.com/IvyYang1999/swob">GitHub</a></nav>
  </header>
  <details class="mobile-chapters"><summary>浏览五章</summary>${navigation}</details>
  <div class="docs-layout">
    <aside class="docs-sidebar">${navigation}
      <div class="side-group"><strong>核心概念</strong><a href="${root}/concepts/vault.html">Vault</a><a href="${root}/concepts/lenses-folders.html">镜头 vs 文件夹</a><a href="${root}/concepts/recovery.html">复活与备份</a><a href="${root}/concepts/lineage.html">血统图谱</a></div>
      <div class="side-group"><strong>功能手册</strong><a href="${root}/guides/resume.html">多客户端 Resume</a><a href="${root}/guides/organize.html">整理与撤销</a><a href="${root}/guides/profiles.html">Profile 与智能重命名</a><a href="${root}/guides/cli.html">CLI 全命令</a><a href="${root}/guides/ssh.html">SSH 远程</a></div>
    </aside>
    <main class="docs-content" id="content">${body}</main>
  </div>
  <footer><span>Swob Docs · 口径先于结论</span><span>本地优先 · 证据可追溯 · 局限明示</span></footer>
</body>
</html>`
}

function hero(kicker, title, lead, badges = '') {
  return `<header class="doc-hero"><p class="doc-kicker">${kicker}</p><h1>${title}</h1><p class="doc-lead">${lead}</p>${badges}</header>`
}

function screenshot(src, alt, caption) {
  return `<figure class="doc-shot"><img src="${src}" alt="${escapeHtml(alt)}" loading="lazy"><figcaption>${escapeHtml(caption)} · 合成数据 / 隐私清洗重建</figcaption></figure>`
}

function quickStartPage() {
  return page({
    title: '快速上手', description: '从安装、首启动三步引导到第一次 Resume。', active: 'quickstart',
    content: `${hero('01 · QUICK START', '先保住历史，再继续工作。', 'Swob 把各家 AI 编程客户端的本地会话汇到一个由你控制的 Vault。下面是从零到第一次续接的最短路径。', '<div class="hero-badges"><span>macOS current main</span><span>本地优先</span><span>约 3 分钟</span></div>')}
      <section><h2>1. 下载与安装</h2><ol class="steps"><li><strong>下载当前稳定版</strong><p>从官网或 GitHub Releases 下载与你 Mac 芯片对应的 DMG。稳定版和 current main 的功能边界以官网标注为准。</p></li><li><strong>首次打开未签名应用</strong><p>如果 macOS 拦截，在系统设置 → 隐私与安全性中确认打开。不要从不明镜像下载。</p></li></ol></section>
      <section><h2>2. 首启动三步</h2><div class="card-grid three"><article><span class="card-index">01</span><h3>选择 Vault</h3><p>选一个你掌控、会备份的位置。Vault 保存 Swob 会话包、索引和组织元数据；改变位置不是改变原客户端目录。</p></article><article><span class="card-index">02</span><h3>排除来源</h3><p>取消勾选的 harness 将不显示、也不备份。以后可在设置里调整；排除不是“隐藏筛选”，而是数据边界。</p></article><article><span class="card-index">03</span><h3>延长保留期</h3><p>发现 Claude Code 时，建议把本地会话保留期从默认值延长。它降低源文件被自动清理的风险，但不能替代 Vault 备份。</p></article></div></section>
      <section><h2>3. 第一次 Resume</h2><ol class="steps"><li><strong>在左侧选择会话</strong><p>先核对来源、项目和最后更新时间。旧 ID 会尽量解析到最新的物理续接会话。</p></li><li><strong>点击 Resume</strong><p>默认走该来源可验证的终端命令；下拉菜单里只展示支持的桌面入口。</p></li><li><strong>看清降级提示</strong><p>“打开客户端”不等于“跳到指定会话”。尤其 ZCode 目前只能打开 App/工作区，Swob 会明确提示不能直达历史会话。</p></li></ol><div class="callout"><strong>恢复前的安全边界</strong><p>源文件缺失时，只有实际点击 Resume 才允许进入受控复活流程；复制命令和审计保持只读。</p></div></section>
      ${screenshot('{{site}}/assets/main.png', 'Swob 会话浏览器合成界面', '当前主界面示意')}
      <nav class="next-links"><a href="{{root}}/concepts/vault.html">下一章：理解 Vault →</a><a href="{{root}}/guides/resume.html">直接看多客户端 Resume →</a></nav>`
  })
}

const conceptPages = {
  'concepts/vault.html': {
    title: 'Vault：会话是你的文件', active: 'concepts', screenshot: 'sidebar.png', alt: 'Swob Vault 左侧栏合成界面',
    lead: 'Vault 是 Swob 的本地资料库边界。它不是某个云账号，也不是把源客户端目录据为己有。',
    body: `<section><h2>它保存什么</h2><p>每个会话以受管会话包存在，带有标记、派生 transcript、来源证据和组织元数据。SQLite 搜索索引可以重建；原始 harness transcript 与 Swob 转录都不应靠手工编辑来“修复”。</p><div class="principle"><strong>第一原则</strong><p>原始记录是证据，Vault 是可管理、可备份的本地副本。浏览、整理与恢复都应保留这条边界。</p></div></section><section><h2>你负责的两件事</h2><ul class="checks"><li>把 Vault 放在你理解其同步/备份语义的位置。</li><li>不要手工移动单个会话包；在 Swob 里整理，才能记录可撤销事务。</li></ul></section>`
  },
  'concepts/lenses-folders.html': {
    title: '镜头 vs 文件夹', active: 'concepts', screenshot: 'sidebar.png', alt: 'Swob 镜头和文件夹导航合成界面',
    lead: '镜头改变“怎么看”，文件夹改变“放在哪”。只有后者会移动 Vault 内的会话包。',
    body: `<section><h2>两层导航，不混为一谈</h2><div class="table-scroll"><table><thead><tr><th>对象</th><th>本质</th><th>是否移动文件</th><th>适合</th></tr></thead><tbody><tr><td>镜头</td><td>按来源、项目、活跃度等形成的动态视图</td><td>否</td><td>临时观察与筛选</td></tr><tr><td>文件夹</td><td>Vault 中的持久组织结构</td><td>是，走事务</td><td>长期归档与团队约定</td></tr></tbody></table></div></section><section><h2>为什么要分开</h2><p>如果筛选被伪装成文件夹，用户会误以为数据已移动或已归档。Swob 让镜头保持可逆的观察层，把真正的磁盘变更交给带操作日志的整理事务。</p></section>`
  },
  'concepts/recovery.html': {
    title: '复活与备份', active: 'concepts', screenshot: 'main.png', alt: 'Swob 会话详情与恢复入口合成界面',
    lead: '备份回答“内容还在吗”，复活回答“能否安全写回原客户端并继续”。两者不是同一件事。',
    body: `<section><h2>恢复链路</h2><div class="flow"><span>Vault 备份</span><b>校验 ID / JSONL / SHA-256</b><span>选择可信目标实例</span><b>冲突与锁检查</b><span>原子发布并复核</span></div></section><section><h2>保守失败是功能</h2><p>目标目录不可信、清单缺失、同 ID 冲突或备份未验证时，Swob 会停下来，而不是“尽量写进去”。完整失败原因见<a href="{{root}}/troubleshooting.html#recovery-failures">恢复失败原因表</a>。</p><div class="callout warning"><strong>备份可读 ≠ 可直接 Resume</strong><p>恢复有效性还依赖来源、物理 session ID、目标客户端实例和写回后的验证。</p></div></section>`
  },
  'concepts/lineage.html': {
    title: '血统图谱', active: 'concepts', screenshot: 'graph-view.png', alt: 'Swob Session Galaxy 合成图谱',
    lead: 'Resume、Fork 与 compact 会产生关系，不只是“又多了一行”。血统图谱把强证据和相似性邻近分开。',
    body: `<section><h2>什么是强关系</h2><p>明确的 fork/continuation ID、物理会话续接和 compact 边界属于可验证血统。相同项目、时间邻近、cwd 或文件亲和度只能帮助导航，不能冒充父子关系。</p></section><section><h2>图谱能做什么</h2><ul class="checks"><li>从旧逻辑 ID 定位最新可续接的物理会话。</li><li>看见分叉、续接和上下文压缩造成的历史断面。</li><li>点击节点回到会话证据，而不是只看视觉聚类。</li></ul></section>`
  }
}

function conceptPage(data) {
  return page({
    title: data.title, description: data.lead, active: data.active, root: '..', site: '../..',
    content: `${hero('02 · CORE CONCEPT', data.title, data.lead)}${screenshot(`{{site}}/assets/${data.screenshot}`, data.alt, '当前 UI 示意')}${data.body}<nav class="concept-index"><a href="{{root}}/concepts/vault.html">Vault</a><a href="{{root}}/concepts/lenses-folders.html">镜头 vs 文件夹</a><a href="{{root}}/concepts/recovery.html">复活与备份</a><a href="{{root}}/concepts/lineage.html">血统图谱</a></nav>`
  })
}

function metricsPage(truth) {
  const components = truth.componentFields.map((field) => metricCard(componentDocs[field])).join('\n')
  const accounting = accountingDocs.map((metric) => metricCard(metric)).join('\n')
  const audits = truth.auditFields.filter((field) => !auditMetadataFields.has(field)).map((field) => metricCard(auditMetric(field), 'experimental')).join('\n')
  return page({
    title: '统计口径字典', description: 'Swob 所有用户可见统计数字的定义、来源、算法、局限与界面位置。', active: 'metrics',
    content: `<!-- generated metric skeleton: token-accounting.ts + session-audit.ts + token-valuation.ts -->${hero('03 · METRIC DICTIONARY', '每个数字，都要说清楚从哪来。', '稳定 anchor 是产品契约。改名或删除会破坏从仪表盘 ⓘ 跳来的链接；新增代码字段而没有人工解释时，测试会直接失败。', `<div class="hero-badges"><span>5 类 / ${truth.componentFields.length} 个 token 字段</span><span>${truth.auditFields.filter((field) => !auditMetadataFields.has(field)).length} 个审计字段</span><span>${truth.valuationModes.length} 种估值 mode</span></div>`)}
      <div class="callout"><strong>先选范围，再看数</strong><p><a href="#billing-total">billing total</a> 与 <a href="#conversation-only">conversation only</a> 的分母不同；<a href="#input-plus-output">input_plus_output</a> 又明确排除缓存桶。unavailable/unpriced 从不等于 0。</p></div>
      <section><h2>Token 五类</h2><p class="section-lead">非缓存输入、cache read、cache write、output、reasoning 是五类语义；cache write 在代码中进一步拆成 TTL 未知、5m、1h 三个互斥字段，因此当前共 ${truth.componentFields.length} 个字段。reasoning 是 output 子集，不重复计数。</p><div class="metric-list">${components}</div></section>
      <section><h2>汇总、估值与数据质量</h2><div class="metric-list">${accounting}</div></section>
      <section id="session-audit"><h2>Session Audit 指标</h2><p class="section-lead"><span class="pill experimental">全部实验</span> 每项都应和 evidence、provenance、caveat 一起读。methodologyVersion 当前为 <code>experimental-v2</code>。</p><div class="metric-list">${audits}</div></section>`
  })
}

const guidePages = {
  'guides/resume.html': {
    title: '多客户端 Resume', active: 'guides',
    lead: 'Resume 的承诺只到目标客户端公开支持的边界。Swob 不把“打开 App”包装成“恢复成功”。',
    body: `<section><h2>当前行为矩阵</h2><div class="table-scroll"><table><thead><tr><th>来源</th><th>终端</th><th>桌面入口</th><th>诚实降级</th></tr></thead><tbody><tr><td>Claude Code</td><td><code>claude --resume</code></td><td>Claude Desktop 导入（实验开关）；Remote Control</td><td>桌面入口关闭时不生成假动作</td></tr><tr><td>Codex</td><td><code>codex resume</code></td><td><code>codex://threads/&lt;id&gt;</code></td><td>只允许 Codex 同源会话</td></tr><tr><td>Cursor</td><td><code>cursor agent --resume</code></td><td>无</td><td>保留来源能力边界</td></tr><tr><td>OpenCode</td><td><code>opencode --session</code></td><td>无</td><td>保留来源能力边界</td></tr><tr><td>ZCode</td><td>无公开 CLI</td><td>打开 <code>zcode://</code> 或工作区</td><td>明确提示不能跳到指定历史会话</td></tr><tr><td>CC-Mirror / 其他公开 CLI 来源</td><td>按各自 launcher 续接</td><td>无</td><td>缺 launcher 时不可伪造支持</td></tr></tbody></table></div></section><section><h2>源文件缺失时</h2><p>点击 Resume 会先做可恢复性检查；确需写回时进入受控复活流程。复制 Resume 命令和 Resume Audit 不允许触发写回。</p><div class="callout warning"><strong>Claude Desktop 仍是实验能力</strong><p>必须先在设置开启“实验：导入到 Claude Desktop”；来源不是 Claude Code 或 session ID 格式不合法时会拒绝。</p></div></section>`
  },
  'guides/organize.html': {
    title: '整理与撤销', active: 'guides',
    lead: '移动和重命名不是散落的文件操作，而是一笔先记反向计划、再执行的 Vault 事务。',
    body: `<section><h2>安全整理</h2><ol class="steps"><li><strong>先预览</strong><p>项目整理与智能整理先给出目标文件夹和元数据变化。</p></li><li><strong>整批提交</strong><p>每个会话包必须有正确标记，目标必须在当前 Vault 内；重名会生成安全后缀。</p></li><li><strong>需要时撤销</strong><p>“撤销最近整理”只处理最近一笔 applied/partial 事务，先完整预检再反向移动。</p></li></ol></section><section><h2>撤销不会做什么</h2><ul class="checks"><li>不会覆盖后来占据原位置的内容。</li><li>不会删除整理后新增的非空文件夹。</li><li>不会猜测损坏日志的反向路径。</li><li>每次只撤销最近一笔组织事务。</li></ul></section>`
  },
  'guides/profiles.html': {
    title: 'Profile 与智能重命名', active: 'guides',
    lead: '智能功能先绑定 Profile，再明确调用模型。凭据只进系统 Keychain，不写回普通配置。',
    body: `<section><h2>配置顺序</h2><ol class="steps"><li><strong>创建 Profile</strong><p>选择 Anthropic、OpenAI 或兼容自定义服务，填写模型和可选 Base URL。</p></li><li><strong>保存凭据</strong><p>凭据写入本机 Keychain；列表只显示末四位 hint。Base URL 不允许内嵌账号、密码、查询或片段。</p></li><li><strong>绑定智能重命名</strong><p>不同智能功能可绑定不同 Profile。未绑定、Profile 不存在或凭据缺失都会给出明确错误。</p></li></ol></section><section><h2>批量智能重命名</h2><p>每次 1–50 个会话；模型只接收经过秘密脱敏、每段最多 3,000 字符的标题/首条用户消息/摘要。先预览，再把确认后的标题写入 Swob 自定义元数据。</p><div class="callout"><strong>标题约束</strong><p>最多 30 个字符、无句末标点、返回必须是严格 JSON 且完整覆盖所选 session ID；格式错误只重试一次。</p></div></section>`
  },
  'guides/ssh.html': {
    title: 'SSH 远程 Resume', active: 'guides',
    lead: 'Swob 只编排你已经能安全登录的 SSH 主机；它不接管私钥，也不替你绕过远端权限。',
    body: `<section><h2>准备</h2><ol class="steps"><li><strong>配置 SSH 密钥</strong><p>本机运行 <code>ssh-keygen</code>，用 <code>ssh-copy-id user@host</code> 安装公钥；私钥只留本机。</p></li><li><strong>先在终端验证</strong><p>确认 <code>ssh user@host</code> 无需交互密码，并且远端工作目录和 claude launcher 存在。</p></li><li><strong>填入设置</strong><p>设置 → SSH 填 host、user；只有 launcher 不在 PATH 时才填“远程路径”。</p></li></ol></section><section><h2>Swob 实际执行什么</h2><pre><code>ssh -t user@host 'zsh -li -c "cd &lt;remote-cwd&gt; &amp;&amp; claude --resume &lt;id&gt;"'</code></pre><p>交互登录 shell 同时加载远端 <code>~/.zprofile</code> 与 <code>~/.zshrc</code>。路径和 session ID 都经过 shell quote。</p><div class="callout warning"><strong>范围</strong><p>SSH Resume 当前面向远端 Claude Code 会话。Windows Native Alpha 不开放 SSH 设置入口。</p></div></section>`
  }
}

function guidePage(data) {
  return page({ title: data.title, description: data.lead, active: data.active, root: '..', site: '../..', content: `${hero('04 · FEATURE GUIDE', data.title, data.lead)}${data.body}<nav class="next-links"><a href="{{root}}/guides/cli.html">CLI 全命令 →</a><a href="{{root}}/troubleshooting.html">遇到问题？看排障 →</a></nav>` })
}

function simpleHash(value) {
  let hash = 0
  for (const char of value) hash = ((hash << 5) - hash + char.codePointAt(0)) | 0
  return hash
}

function cliPage(truth) {
  const commandRows = truth.cliCommands.map((command) => `<article class="command" id="${kebab(command.usage.split(/\s/)[0])}-${Math.abs(simpleHash(command.usage))}"><h3><code>swob ${escapeHtml(command.usage)}</code></h3><p>${escapeHtml(command.summary)}</p><dl><dt>输出</dt><dd>${escapeHtml(command.output)}</dd><dt>示例</dt><dd>${command.examples.map((example) => `<code>${escapeHtml(example)}</code>`).join('<br>')}</dd></dl></article>`).join('\n')
  const exits = truth.cliExitCodes.map(({ code, meaning }) => `<tr><td><code>${code}</code></td><td>${escapeHtml(meaning)}</td></tr>`).join('')
  return page({
    title: 'CLI 全命令', description: `Swob CLI ${truth.cliVersion} 的完整命令参考，由 command-registry 自动生成。`, active: 'guides', root: '..', site: '../..',
    content: `<!-- generated from src/cli/command-registry.ts -->${hero('04 · GENERATED CLI', `CLI ${truth.cliVersion} 全命令`, '本页命令、摘要、输出和示例与 /swob skill 使用同一个 command registry。改代码不重新生成，测试会失败。', `<div class="hero-badges"><span>${truth.cliCommands.length} 条命令</span><span>机器输出优先 JSON</span></div>`)}<section><h2>机器接口约定</h2><ul class="checks"><li><code>--json</code> 时 stdout 只包含合法 JSON，诊断写 stderr。</li><li><code>show --format=jsonl</code> 每行一个独立 JSON 事件。</li><li>批量 move/rename 整批先校验再提交；<code>undo</code> 只撤销最近一次组织事务。</li><li>token 汇总的 <code>input_plus_output</code> 不包含 cache creation/read。</li></ul><table class="compact"><thead><tr><th>退出码</th><th>含义</th></tr></thead><tbody>${exits}</tbody></table></section><section><h2>命令参考</h2><div class="command-list">${commandRows}</div></section>`
  })
}

function troubleshootingPage(truth) {
  const reasons = Object.entries(truth.recoveryMessages).map(([reason, message]) => `<tr id="recovery-${escapeHtml(reason)}"><td><code>${escapeHtml(reason)}</code></td><td>${escapeHtml(message)}</td></tr>`).join('\n')
  return page({
    title: 'FAQ 与故障排查', description: '会话消失、复活失败原因与 Windows Native Alpha 能力边界。', active: 'troubleshooting',
    content: `<!-- generated recovery table: src/main/recovery-failure-message.ts -->${hero('05 · TROUBLESHOOTING', '先定位失败层，再决定下一步。', '会话“看不见”、备份“还在”和目标客户端“能 Resume”属于三层问题。不要用一次重试掩盖证据缺口。')}
      <section id="missing-session"><h2>为什么会话突然消失？</h2><p>先确认它是从 Swob 视图消失，还是原客户端源文件真的被清理。Claude Code 的本地保留策略可能删除旧源文件：一次真实审计中，1,621 个会话里有 253 个原路径已缺失，但 Vault 备份仍在。这个比例只描述该审计语料，不是每个人的预言。</p><ol class="steps"><li><strong>检查来源排除</strong><p>首启动或设置里排除的来源既不显示也不备份。</p></li><li><strong>搜索 Vault</strong><p>用标题、项目或 transcript 全文确认 Swob 副本是否存在。</p></li><li><strong>检查保留期</strong><p>对 Claude Code 延长本地会话保留期；它只能降低未来风险，不能凭空恢复已删除文件。</p></li><li><strong>需要续接时再复活</strong><p>只有点击 Resume 才进入受控写回；先核对目标实例和冲突。</p></li></ol></section>
      <section id="recovery-failures"><h2>复活失败原因（当前 ${Object.keys(truth.recoveryMessages).length} 类）</h2><p class="section-lead">本表直接从代码消息表生成。任务设计稿曾写“24 类”，当前主干真相源实际是 ${Object.keys(truth.recoveryMessages).length} 类；以后代码增删而文档未更新，生成检查会失败。</p><div class="table-scroll"><table><thead><tr><th>reason</th><th>用户可见说明</th></tr></thead><tbody>${reasons}</tbody></table></div></section>
      <section id="windows-alpha"><h2>Windows Native Alpha 边界</h2><p>Alpha 只验证 Windows x64 上 Claude Code 与 Codex 的本地浏览、搜索、备份、Resume 和 Library 最小闭环，不是 macOS 功能对等版。</p><div class="card-grid"><article><h3>支持</h3><p>Windows Native x64；Claude Code、Codex；Windows Terminal / PowerShell / cmd Resume。</p></article><article><h3>不支持 / 不在本阶段</h3><p>其他九类 harness、WSL、OneDrive 占位文件、Windows CLI 安装、ARM64、自动更新、签名、SSH 和手机连接。</p></article></div><p>本站只保留用户能力边界；构建、CI 证据与真机验收清单见仓库的 <a href="https://github.com/IvyYang1999/swob/blob/master/docs/windows-alpha.md">Windows Alpha 工程文档</a>，不把 CI 证据包装成已经交付的功能承诺。</p></section>`
  })
}

function englishPlaceholder(title, counterpart, root, site) {
  return page({
    title, description: 'Reserved English documentation route.', active: 'english', root, site, english: true,
    content: `${hero('ENGLISH STRUCTURE · RESERVED', title, 'The Chinese documentation is the current source of truth. This route is reserved so the future English site can mirror the same information architecture without changing URLs.')}<section><h2>Not translated yet</h2><p>Use the <a href="${counterpart}">current Chinese page</a>. Do not rely on this placeholder for product behavior.</p></section>`
  })
}

export function renderAll(truth = collectTruth()) {
  validateTruth(truth)
  const outputs = new Map()
  outputs.set('index.html', quickStartPage())
  for (const [file, data] of Object.entries(conceptPages)) outputs.set(file, conceptPage(data))
  outputs.set('metrics.html', metricsPage(truth))
  for (const [file, data] of Object.entries(guidePages)) outputs.set(file, guidePage(data))
  outputs.set('guides/cli.html', cliPage(truth))
  outputs.set('troubleshooting.html', troubleshootingPage(truth))

  const chineseRoutes = [...outputs.keys()]
  for (const route of chineseRoutes) {
    const englishRoute = `en/${route}`
    const depth = englishRoute.split('/').length - 1
    const root = depth === 1 ? '..' : '../..'
    const site = depth === 1 ? '../..' : '../../..'
    const counterpart = `${root}/${route}`
    outputs.set(englishRoute, englishPlaceholder(`Swob Docs · ${route}`, counterpart, root, site))
  }

  const manifest = {
    generatedBy: 'scripts/generate-docs.mjs',
    sourceFiles,
    tokenComponentFields: truth.componentFields,
    auditMetricFields: truth.auditFields.filter((field) => !auditMetadataFields.has(field)),
    valuationFields: truth.valuationFields,
    valuationModes: truth.valuationModes,
    cliVersion: truth.cliVersion,
    cliCommandCount: truth.cliCommands.length,
    recoveryFailureCount: Object.keys(truth.recoveryMessages).length,
    stableMetricAnchors: [
      ...truth.componentFields.map((field) => componentDocs[field].anchor),
      ...accountingDocs.map((metric) => metric.anchor),
      ...truth.auditFields.filter((field) => !auditMetadataFields.has(field)).map((field) => `audit-${kebab(field)}`)
    ]
  }
  outputs.set('generated-manifest.json', `${JSON.stringify(manifest, null, 2)}\n`)
  return outputs
}

export function writeOrCheck({ check = false, outputDir = defaultOutputDir } = {}) {
  const outputs = renderAll()
  const stale = []
  for (const [relativePath, expected] of outputs) {
    const filePath = path.join(outputDir, relativePath)
    if (check) {
      const actual = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : null
      if (actual !== expected) stale.push(relativePath)
      continue
    }
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(filePath, expected)
  }
  if (stale.length) {
    throw new Error(`文档导出已过期：${stale.join(', ')}。请重新运行 npm run docs:export。`)
  }
  return outputs
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2)
    const outputIndex = args.indexOf('--output-dir')
    const outputDir = outputIndex >= 0
      ? path.resolve(args[outputIndex + 1])
      : defaultOutputDir
    if (outputIndex >= 0 && !args[outputIndex + 1]) {
      throw new Error('--output-dir 需要目录路径')
    }
    const outputs = writeOrCheck({ check: args.includes('--check'), outputDir })
    console.log(args.includes('--check')
      ? `文档导出检查通过（${outputs.size} 个生成物）`
      : `已导出 ${outputs.size} 个网站文档文件到 ${path.relative(repoRoot, outputDir)}`)
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  }
}
