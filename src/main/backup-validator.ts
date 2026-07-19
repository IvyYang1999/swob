import { selectClaudeDefaultChain } from './claude-main-chain'

export type BackupFragmentShape =
  | 'physical-newline-in-string'
  | 'orphan-tail'
  | 'interleaved-fragments'
  | 'missing-prefix'
  | 'separated-fragments'
  | 'malformed-json'
  | 'blank-line'
  | 'non-object'
  | 'invalid-utf8'
  | 'unsupported-line-ending'

export type BackupValidationErrorCode =
  | 'empty-backup'
  | 'malformed-jsonl'
  | 'missing-session-id'
  | 'invalid-session-id'
  | 'session-id-conflict'
  | 'missing-claude-message'
  | 'missing-resume-evidence'

export interface BackupValidationOptions {
  expectedLogicalSessionId?: string
  expectedPhysicalSessionId?: string
}

export interface ParsedBackupLine {
  lineNumber: number
  byteStart: number
  byteEnd: number
  value: Record<string, unknown>
}

export interface PhysicalNewlineBreak {
  lineStart: number
  lineEnd: number
  byteStart: number
  byteEnd: number
  form: 'lf' | 'crlf' | 'cr'
  escapedBefore: boolean
}

export interface BackupBrokenFragment {
  lineStart: number
  lineEnd: number
  byteStart: number
  byteEnd: number
  shape: BackupFragmentShape
  diagnostic: string
}

export interface BackupSessionIdTransition {
  from: string
  to: string
  lineNumber: number
  evidence?: 'direct-parent' | 'summary-leaf'
}

export interface BackupMainChainRelation {
  kind: 'none' | 'single' | 'continuation' | 'conflict'
  logicalSessionId?: string
  physicalSessionId?: string
  mainChainSessionIds: string[]
  transitions: BackupSessionIdTransition[]
  reason?: string
}

export interface BackupValidationError {
  code: BackupValidationErrorCode
  diagnostic: string
  lineNumber?: number
}

export interface BackupValidationResult {
  ok: boolean
  byteLength: number
  physicalLineCount: number
  parseableLineCount: number
  parsedLines: ParsedBackupLine[]
  fragments: BackupBrokenFragment[]
  physicalNewlineBreaks: PhysicalNewlineBreak[]
  sessionIds: string[]
  mainChain: BackupMainChainRelation
  errors: BackupValidationError[]
}

interface PhysicalLine {
  lineNumber: number
  byteStart: number
  byteEnd: number
  rawEnd: number
  bytes: Buffer
}

interface InvalidLine {
  line: PhysicalLine
  shape?: BackupFragmentShape
  diagnostic: string
  text?: string
}

interface ChainRecord extends Record<string, unknown> {
  __lineNumber: number
  uuid?: string
  parentUuid?: string | null
  logicalParentUuid?: string | null
  isSidechain?: boolean
  sessionId?: string
  type?: string
  leafUuid?: string
  forkedFrom?: { sessionId?: unknown; messageUuid?: unknown }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function inputBuffer(input: Buffer | string): Buffer {
  return Buffer.isBuffer(input) ? Buffer.from(input) : Buffer.from(input, 'utf8')
}

function splitPhysicalLines(content: Buffer): PhysicalLine[] {
  const lines: PhysicalLine[] = []
  let byteStart = 0
  let lineNumber = 1
  for (let index = 0; index < content.length; index++) {
    if (content[index] !== 0x0a) continue
    const byteEnd = index > byteStart && content[index - 1] === 0x0d ? index - 1 : index
    lines.push({
      lineNumber,
      byteStart,
      byteEnd,
      rawEnd: index + 1,
      bytes: content.subarray(byteStart, byteEnd)
    })
    byteStart = index + 1
    lineNumber++
  }
  if (byteStart < content.length) {
    lines.push({
      lineNumber,
      byteStart,
      byteEnd: content.length,
      rawEnd: content.length,
      bytes: content.subarray(byteStart)
    })
  }
  return lines
}

/** Locate raw LF/CRLF boundaries that occur while the JSON lexer is inside a quoted string. */
export function detectPhysicalNewlinesInStrings(input: Buffer | string): PhysicalNewlineBreak[] {
  const content = inputBuffer(input)
  const breaks: PhysicalNewlineBreak[] = []
  let inString = false
  let escaped = false
  let lineNumber = 1

  for (let index = 0; index < content.length; index++) {
    const byte = content[index]
    if (byte === 0x0a) {
      const hasCarriageReturn = index > 0 && content[index - 1] === 0x0d
      if (inString) {
        breaks.push({
          lineStart: lineNumber,
          lineEnd: lineNumber + 1,
          byteStart: hasCarriageReturn ? index - 1 : index,
          byteEnd: index + 1,
          form: hasCarriageReturn ? 'crlf' : 'lf',
          escapedBefore: escaped
        })
      }
      escaped = false
      lineNumber++
      continue
    }
    if (byte === 0x0d && content[index + 1] !== 0x0a) {
      if (inString) {
        breaks.push({
          lineStart: lineNumber,
          lineEnd: lineNumber + 1,
          byteStart: index,
          byteEnd: index + 1,
          form: 'cr',
          escapedBefore: escaped
        })
      }
      escaped = false
      lineNumber++
      continue
    }
    if (!inString) {
      if (byte === 0x22) inString = true
      continue
    }
    if (escaped) {
      escaped = false
    } else if (byte === 0x5c) {
      escaped = true
    } else if (byte === 0x22) {
      inString = false
    }
  }
  return breaks
}

function decodeLine(line: PhysicalLine): { text?: string; error?: string } {
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(line.bytes) }
  } catch {
    return { error: 'physical line is not valid UTF-8' }
  }
}

function invalidFragments(
  invalidLines: InvalidLine[],
  newlineBreaks: PhysicalNewlineBreak[]
): BackupBrokenFragment[] {
  const fragments: BackupBrokenFragment[] = newlineBreaks.map((boundary) => ({
    lineStart: boundary.lineStart,
    lineEnd: boundary.lineEnd,
    byteStart: boundary.byteStart,
    byteEnd: boundary.byteEnd,
    shape: boundary.form === 'cr' ? 'unsupported-line-ending' : 'physical-newline-in-string',
    diagnostic: boundary.form === 'cr'
      ? 'raw CR line endings are unsupported and will not be rewritten as LF'
      : `raw ${boundary.form.toUpperCase()} occurs inside a quoted JSON string`
  }))
  const coveredLines = new Set<number>()
  for (const boundary of newlineBreaks) {
    coveredLines.add(boundary.lineStart)
    coveredLines.add(boundary.lineEnd)
  }
  const remaining = invalidLines.filter(({ line }) => !coveredLines.has(line.lineNumber))
  if (remaining.length === 0) return fragments

  const hasSeparatedFragments = remaining.some((item, index) =>
    index > 0 && item.line.lineNumber > remaining[index - 1].line.lineNumber + 1)
  if (hasSeparatedFragments) {
    fragments.push({
      lineStart: remaining[0].line.lineNumber,
      lineEnd: remaining[remaining.length - 1].line.lineNumber,
      byteStart: remaining[0].line.byteStart,
      byteEnd: remaining[remaining.length - 1].line.byteEnd,
      shape: 'separated-fragments',
      diagnostic: 'malformed fragments are separated by at least one complete JSON object'
    })
    return fragments
  }

  if (remaining.length > 1) {
    fragments.push({
      lineStart: remaining[0].line.lineNumber,
      lineEnd: remaining[remaining.length - 1].line.lineNumber,
      byteStart: remaining[0].line.byteStart,
      byteEnd: remaining[remaining.length - 1].line.byteEnd,
      shape: 'interleaved-fragments',
      diagnostic: 'multiple adjacent malformed physical lines cannot be joined uniquely'
    })
    return fragments
  }

  const invalid = remaining[0]
  let shape = invalid.shape
  if (!shape) {
    const text = invalid.text || ''
    const trimmed = text.trimStart()
    const leadingWhitespace = text.length - trimmed.length
    if (trimmed && !trimmed.startsWith('{')) {
      shape = leadingWhitespace >= 2 ? 'missing-prefix' : 'orphan-tail'
    } else {
      shape = 'malformed-json'
    }
  }
  fragments.push({
    lineStart: invalid.line.lineNumber,
    lineEnd: invalid.line.lineNumber,
    byteStart: invalid.line.byteStart,
    byteEnd: invalid.line.byteEnd,
    shape,
    diagnostic: invalid.diagnostic
  })
  return fragments
}

function isClaudeMessageRecord(record: ChainRecord): boolean {
  return (record.type === 'user' || record.type === 'assistant') &&
    !!record.message && typeof record.message === 'object' && !Array.isArray(record.message)
}

function messageHasUsableAnchor(record: ChainRecord): boolean {
  if (!isClaudeMessageRecord(record)) return false
  const content = (record.message as Record<string, unknown>).content
  if (typeof content === 'string') return content.trim().length > 0
  if (!Array.isArray(content)) return false
  return content.some((part) => {
    if (!part || typeof part !== 'object' || Array.isArray(part)) return false
    const value = part as Record<string, unknown>
    return value.type === 'text' && typeof value.text === 'string' && value.text.trim().length > 0
  })
}

function hasUsableUuidChain(records: ChainRecord[]): boolean {
  const uuids = new Set(records
    .filter((record) => typeof record.uuid === 'string' && record.uuid.length > 0)
    .map((record) => record.uuid!))
  return records.some((record) =>
    (typeof record.parentUuid === 'string' && uuids.has(record.parentUuid)) ||
    (typeof record.logicalParentUuid === 'string' && uuids.has(record.logicalParentUuid)) ||
    (record.type === 'summary' && typeof record.leafUuid === 'string' && uuids.has(record.leafUuid))
  )
}

function encounterOrder(values: Array<string | undefined>): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const value of values) {
    if (!value || seen.has(value)) continue
    seen.add(value)
    result.push(value)
  }
  return result
}

function compressedIds(rows: ChainRecord[]): string[] {
  const result: string[] = []
  for (const row of rows) {
    if (!row.sessionId || result[result.length - 1] === row.sessionId) continue
    result.push(row.sessionId)
  }
  return result
}

function mainChainRelation(
  records: ChainRecord[],
  sessionIds: string[],
  options: BackupValidationOptions
): BackupMainChainRelation {
  // A continuation summary's leafUuid is the formal cross-session parent
  // pointer (session-lineage.ts uses the same rule). Project that edge only
  // for chain selection; do not rewrite the parsed record.
  const chainRecords = records.map((record) =>
    record.type === 'summary' && record.leafUuid && !record.parentUuid && !record.logicalParentUuid
      ? { ...record, logicalParentUuid: record.leafUuid }
      : record
  )
  const defaultChain = selectClaudeDefaultChain(chainRecords)
  const mainChainSessionIds = compressedIds(defaultChain)
  const logical = options.expectedLogicalSessionId
  const physical = options.expectedPhysicalSessionId

  if (sessionIds.length === 0) {
    return { kind: 'none', mainChainSessionIds, transitions: [], reason: 'no top-level sessionId found' }
  }
  if (sessionIds.length === 1) {
    const only = sessionIds[0]
    if ((logical && logical !== only) || (physical && physical !== only)) {
      return {
        kind: 'conflict', logicalSessionId: logical, physicalSessionId: physical,
        mainChainSessionIds, transitions: [], reason: 'single content ID does not match the expected target IDs'
      }
    }
    return {
      kind: 'single', logicalSessionId: logical || only, physicalSessionId: physical || only,
      mainChainSessionIds: mainChainSessionIds.length > 0 ? mainChainSessionIds : [only], transitions: []
    }
  }

  if (sessionIds.length !== 2 || !logical || !physical || logical === physical ||
    !sessionIds.includes(logical) || !sessionIds.includes(physical)) {
    return {
      kind: 'conflict', logicalSessionId: logical, physicalSessionId: physical,
      mainChainSessionIds, transitions: [],
      reason: 'multiple IDs require exactly the distinct expected logical and physical IDs'
    }
  }
  if (mainChainSessionIds.length !== 2 || mainChainSessionIds[0] !== logical ||
    mainChainSessionIds[1] !== physical) {
    return {
      kind: 'conflict', logicalSessionId: logical, physicalSessionId: physical,
      mainChainSessionIds, transitions: [],
      reason: 'default main chain must transition exactly once from logical ID to physical ID'
    }
  }

  const logicalUuids = new Set(records
    .filter((row) => row.sessionId === logical && !row.isSidechain && row.uuid)
    .map((row) => row.uuid!))
  const firstPhysical = defaultChain.find((row) => row.sessionId === physical)
  if (records.some((row) => row.sessionId === physical && row.forkedFrom)) {
    return {
      kind: 'conflict', logicalSessionId: logical, physicalSessionId: physical,
      mainChainSessionIds, transitions: [],
      reason: 'forkedFrom identifies a fork, not a legal continuation'
    }
  }
  let evidence: BackupSessionIdTransition['evidence']
  if (firstPhysical?.type === 'summary' && firstPhysical.leafUuid && logicalUuids.has(firstPhysical.leafUuid)) {
    evidence = 'summary-leaf'
  } else if (firstPhysical && ((firstPhysical.parentUuid && logicalUuids.has(firstPhysical.parentUuid)) ||
    (firstPhysical.logicalParentUuid && logicalUuids.has(firstPhysical.logicalParentUuid)))) {
    evidence = 'direct-parent'
  } else if (records.some((row) =>
    row.sessionId === physical && row.type === 'summary' && !!row.leafUuid && logicalUuids.has(row.leafUuid))) {
    evidence = 'summary-leaf'
  }
  if (!firstPhysical || !evidence) {
    return {
      kind: 'conflict', logicalSessionId: logical, physicalSessionId: physical,
      mainChainSessionIds, transitions: [],
      reason: 'logical-to-physical transition lacks a parentUuid/logicalParentUuid or summary.leafUuid anchor'
    }
  }

  return {
    kind: 'continuation',
    logicalSessionId: logical,
    physicalSessionId: physical,
    mainChainSessionIds,
    transitions: [{ from: logical, to: physical, lineNumber: firstPhysical.__lineNumber, evidence }]
  }
}

/** Strict, deterministic, read-only validation of Claude backup JSONL bytes. */
export function validateBackupJsonl(
  input: Buffer | string,
  options: BackupValidationOptions = {}
): BackupValidationResult {
  const content = inputBuffer(input)
  const lines = splitPhysicalLines(content)
  const parsedLines: ParsedBackupLine[] = []
  const invalidLines: InvalidLine[] = []
  const errors: BackupValidationError[] = []

  for (const line of lines) {
    if (line.bytes.length === 0) {
      invalidLines.push({ line, shape: 'blank-line', diagnostic: 'blank physical line is not valid JSONL' })
      continue
    }
    const decoded = decodeLine(line)
    if (decoded.error) {
      invalidLines.push({ line, shape: 'invalid-utf8', diagnostic: decoded.error })
      continue
    }
    try {
      const value: unknown = JSON.parse(decoded.text!)
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        invalidLines.push({
          line, text: decoded.text, shape: 'non-object',
          diagnostic: 'each JSONL line must be a top-level object'
        })
        continue
      }
      parsedLines.push({
        lineNumber: line.lineNumber,
        byteStart: line.byteStart,
        byteEnd: line.byteEnd,
        value: value as Record<string, unknown>
      })
    } catch {
      invalidLines.push({ line, text: decoded.text, diagnostic: 'physical line is not valid JSON' })
    }
  }

  if (lines.length === 0) {
    errors.push({ code: 'empty-backup', diagnostic: 'backup contains no JSONL records' })
  }
  const physicalNewlineBreaks = detectPhysicalNewlinesInStrings(content)
  const fragments = invalidFragments(invalidLines, physicalNewlineBreaks)
  if (fragments.length > 0) {
    errors.push({ code: 'malformed-jsonl', diagnostic: `${fragments.length} malformed fragment(s) detected` })
  }

  const records: ChainRecord[] = parsedLines.map((line) => ({
    ...line.value,
    __lineNumber: line.lineNumber
  }))
  const claudeMessageRecords = records.filter(isClaudeMessageRecord)
  if (claudeMessageRecords.length === 0) {
    errors.push({
      code: 'missing-claude-message',
      diagnostic: 'backup must contain at least one parseable Claude user/assistant record with a message object'
    })
  }
  if (!claudeMessageRecords.some(messageHasUsableAnchor) && !hasUsableUuidChain(records)) {
    errors.push({
      code: 'missing-resume-evidence',
      diagnostic: 'backup must contain a usable message anchor or a linked UUID chain'
    })
  }
  for (const record of records) {
    if (typeof record.sessionId !== 'string' || record.sessionId.length === 0) {
      errors.push({
        code: 'missing-session-id',
        diagnostic: 'every parsed backup object must have a non-empty top-level sessionId',
        lineNumber: record.__lineNumber
      })
    } else if (!UUID_RE.test(record.sessionId)) {
      errors.push({
        code: 'invalid-session-id',
        diagnostic: 'top-level sessionId must be a UUID',
        lineNumber: record.__lineNumber
      })
    }
  }
  const sessionIds = encounterOrder(records.map((record) => record.sessionId))
  const mainChain = mainChainRelation(records, sessionIds, options)
  if (mainChain.kind === 'conflict') {
    errors.push({ code: 'session-id-conflict', diagnostic: mainChain.reason || 'session IDs conflict' })
  }

  return {
    ok: errors.length === 0,
    byteLength: content.length,
    physicalLineCount: lines.length,
    parseableLineCount: parsedLines.length,
    parsedLines,
    fragments,
    physicalNewlineBreaks,
    sessionIds,
    mainChain,
    errors
  }
}
