import type { ContentPart, RawJsonlMessage } from './types'
import { isRealUserMessage } from './session-loader'

export interface DerivedFileMeta {
  sessionId: string
}

export interface DerivedFileGenerator {
  name: string
  fileName: string
  generate(rawMessages: RawJsonlMessage[], meta: DerivedFileMeta): string | null
}

interface ExtractedBlock {
  index: number
  timestamp?: string
  text: string
}

export const COMPACT_SUMMARIES_DERIVED_NAME = 'compact-summaries'
export const USER_QUERIES_DERIVED_NAME = 'user-queries'
export const COMPACT_SUMMARIES_FILE = 'compact-summaries.md'
export const USER_QUERIES_FILE = 'user-queries.md'
export const SESSION_SUMMARY_COMPANION_FILE = '摘要.md'

function formatYamlScalar(value: string): string {
  if (/^[A-Za-z0-9_./:@+-]+$/.test(value)) return value
  return JSON.stringify(value)
}

function withDerivedFrontmatter(meta: DerivedFileMeta, generatorName: string, body: string): string {
  return [
    '---',
    `sessionId: ${formatYamlScalar(meta.sessionId)}`,
    `type: derived-${formatYamlScalar(generatorName)}`,
    '---',
    '',
    body.trimEnd(),
    ''
  ].join('\n')
}

function extractContentText(content: string | ContentPart[] | undefined): string {
  if (!content) return ''
  if (typeof content === 'string') return content
  return content
    .map((part) => {
      if (typeof part === 'string') return part
      if (typeof part.text === 'string') return part.text
      return ''
    })
    .filter(Boolean)
    .join('\n')
}

function extractUnknownText(value: unknown): string {
  if (typeof value === 'string') return value
  if (!value || typeof value !== 'object') return ''
  const obj = value as Record<string, unknown>
  for (const key of ['summary', 'text', 'content', 'message']) {
    const nested = obj[key]
    if (typeof nested === 'string') return nested
  }
  return ''
}

function extractRawText(message: RawJsonlMessage): string {
  const fromMessage = extractContentText(message.message?.content)
  if (fromMessage) return fromMessage
  const loose = message as unknown as Record<string, unknown>
  return extractUnknownText(loose.summary) ||
    extractUnknownText(loose.content) ||
    extractUnknownText(loose.text) ||
    extractUnknownText(loose.data)
}

function normalizeBlockText(text: string): string {
  return text.replace(/\r\n/g, '\n').trim()
}

function stripCompactContinuationPrefix(text: string): string {
  const trimmed = normalizeBlockText(text)
  if (!trimmed.startsWith('This session is being continued')) return trimmed

  const markers = [
    'The conversation is summarized below:',
    'Summary:',
    'summary:',
    'Previous conversation summary:',
    'Here is a summary of the conversation so far:'
  ]
  for (const marker of markers) {
    const idx = trimmed.indexOf(marker)
    if (idx >= 0) {
      const summary = trimmed.slice(idx + marker.length).trim()
      return summary || trimmed
    }
  }
  return trimmed
}

function isSummaryType(rawType: unknown): boolean {
  return rawType === 'summary'
}

function isCompactSummaryMessage(message: RawJsonlMessage): boolean {
  const loose = message as unknown as Record<string, unknown>
  if (loose.isCompactSummary === true) return true
  if (isSummaryType(loose.type)) return true
  if (message.subtype === 'compact_summary') return true
  if (message.subtype === 'compact-summary') return true
  return extractRawText(message).trimStart().startsWith('This session is being continued')
}

function sortedBlocks(blocks: ExtractedBlock[]): ExtractedBlock[] {
  return [...blocks].sort((a, b) => {
    if (a.timestamp && b.timestamp && a.timestamp !== b.timestamp) {
      return a.timestamp.localeCompare(b.timestamp)
    }
    if (a.timestamp && !b.timestamp) return -1
    if (!a.timestamp && b.timestamp) return 1
    return a.index - b.index
  })
}

function dedupeBlocks(blocks: ExtractedBlock[]): ExtractedBlock[] {
  const seen = new Set<string>()
  const result: ExtractedBlock[] = []
  for (const block of blocks) {
    const key = `${block.timestamp || ''}\n${block.text}`
    if (seen.has(key)) continue
    seen.add(key)
    result.push(block)
  }
  return result
}

export function extractCompactSummaryBlocks(rawMessages: RawJsonlMessage[]): ExtractedBlock[] {
  const blocks: ExtractedBlock[] = []
  rawMessages.forEach((message, index) => {
    if (!isCompactSummaryMessage(message)) return
    const text = stripCompactContinuationPrefix(extractRawText(message))
    if (!text || text === 'Conversation compacted') return
    blocks.push({ index, timestamp: message.timestamp, text })
  })
  return dedupeBlocks(sortedBlocks(blocks))
}

export function extractUserQueryBlocks(rawMessages: RawJsonlMessage[]): ExtractedBlock[] {
  const blocks: ExtractedBlock[] = []
  rawMessages.forEach((message, index) => {
    if (!isRealUserMessage(message)) return
    const text = normalizeBlockText(extractRawText(message))
    if (!text) return
    blocks.push({ index, timestamp: message.timestamp, text })
  })
  return sortedBlocks(blocks)
}

function formatSectionTitle(index: number, timestamp?: string): string {
  return timestamp ? `## ${index}. ${timestamp}` : `## ${index}`
}

function formatNumberedBlocks(title: string, blocks: ExtractedBlock[]): string {
  const lines: string[] = [`# ${title}`, '']
  blocks.forEach((block, idx) => {
    lines.push(formatSectionTitle(idx + 1, block.timestamp))
    lines.push('')
    lines.push(block.text)
    lines.push('')
  })
  return lines.join('\n')
}

export const COMPACT_SUMMARIES_GENERATOR: DerivedFileGenerator = {
  name: COMPACT_SUMMARIES_DERIVED_NAME,
  fileName: COMPACT_SUMMARIES_FILE,
  generate(rawMessages, meta) {
    const blocks = extractCompactSummaryBlocks(rawMessages)
    if (blocks.length === 0) return null
    return withDerivedFrontmatter(meta, this.name, formatNumberedBlocks('Compact Summaries', blocks))
  }
}

export const USER_QUERIES_GENERATOR: DerivedFileGenerator = {
  name: USER_QUERIES_DERIVED_NAME,
  fileName: USER_QUERIES_FILE,
  generate(rawMessages, meta) {
    const blocks = extractUserQueryBlocks(rawMessages)
    if (blocks.length === 0) return null
    return withDerivedFrontmatter(meta, this.name, formatNumberedBlocks('User Queries', blocks))
  }
}

export const DERIVED_FILE_GENERATORS: DerivedFileGenerator[] = [
  COMPACT_SUMMARIES_GENERATOR,
  USER_QUERIES_GENERATOR
]

export const DERIVED_FILE_NAMES = DERIVED_FILE_GENERATORS.map((generator) => generator.fileName)

export function getEnabledDerivedFileGenerators(enabledNames?: string[]): DerivedFileGenerator[] {
  if (enabledNames === undefined) return DERIVED_FILE_GENERATORS
  const enabled = new Set(enabledNames)
  return DERIVED_FILE_GENERATORS.filter((generator) => enabled.has(generator.name))
}
