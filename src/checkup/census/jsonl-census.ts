/**
 * Spec-correct JSONL reader for the checkup oracle.
 *
 * JSONL separates records with `\n` (0x0A) only. U+2028/U+2029 are legal
 * inside JSON strings and CR is legal JSON whitespace, so neither may split a
 * record. This reader is deliberately independent from every Swob reading
 * path (enforced by the census closure architecture test).
 */
import * as fs from 'node:fs'

export interface JsonlRecordMeta {
  /** 0-based physical line index (split on `\n` only). */
  lineIndex: number
  /** The raw line contains U+2028 or U+2029 as a literal character (the six-character JSON escape of U+2028 does not count). */
  lineSeparator: boolean
  /** The raw line contains a CR that is not the CR of a trailing CRLF. */
  bareCr: boolean
}

export type JsonlVisitor = (record: unknown, meta: JsonlRecordMeta) => void

export interface JsonlFileStats {
  bytesRead: number
  /** Physical `\n`-separated segments; a final `\n` does not create an extra empty segment. */
  lines: number
  nonBlank: number
  blank: number
  parseable: number
  /** Non-blank segments that fail JSON.parse, excluding a truncated tail. */
  badLines: number
  /** Last segment has no trailing `\n`, is non-blank and fails to parse. */
  truncatedTail: boolean
  /** Last segment has no trailing `\n` but parses: not truncated, only unterminated. */
  finalNewlineMissing: boolean
  /** Parseable records containing a literal U+2028/U+2029. */
  lineSeparatorRecords: number
  /** Parseable records containing a bare CR (split hazards for CR-aware readers). */
  bareCrRecords: number
  crlfLines: number
  nonObjectRecords: number
  /** Distribution of the top-level `type` field (sanitised names only). */
  recordTypes: Record<string, number>
}

const LINE_SEPARATOR = Buffer.from([0xe2, 0x80, 0xa8])
const PARAGRAPH_SEPARATOR = Buffer.from([0xe2, 0x80, 0xa9])
const TYPE_NAME = /^[A-Za-z][A-Za-z0-9_]*(?:[-.:][A-Za-z0-9_]+)*$/
export const UNRECOGNIZED_TYPE = 'unrecognized_type'
export const MISSING_TYPE = 'no_type'

/** Record/type names that may be reported: identifier-like and short; anything else is bucketed. */
export function sanitizeTypeName(value: unknown): string {
  if (typeof value !== 'string') return MISSING_TYPE
  return value.length <= 48 && TYPE_NAME.test(value) ? value : UNRECOGNIZED_TYPE
}

export function emptyJsonlStats(): JsonlFileStats {
  return {
    bytesRead: 0,
    lines: 0,
    nonBlank: 0,
    blank: 0,
    parseable: 0,
    badLines: 0,
    truncatedTail: false,
    finalNewlineMissing: false,
    lineSeparatorRecords: 0,
    bareCrRecords: 0,
    crlfLines: 0,
    nonObjectRecords: 0,
    recordTypes: {}
  }
}

function abortError(): Error {
  const error = new Error('checkup aborted')
  error.name = 'AbortError'
  return error
}

/** Stream a JSONL file, splitting on `\n` only, and visit every parseable record. */
export async function readJsonlFile(
  filePath: string,
  visit?: JsonlVisitor,
  options: { signal?: AbortSignal; highWaterMark?: number } = {}
): Promise<JsonlFileStats> {
  const stats = emptyJsonlStats()
  let lineIndex = 0

  const processLine = (buffer: Buffer, start: number, end: number, terminated: boolean): void => {
    stats.lines++
    const index = lineIndex++
    let contentEnd = end
    if (terminated && contentEnd > start && buffer[contentEnd - 1] === 0x0d) {
      stats.crlfLines++
      contentEnd--
    }
    const text = buffer.toString('utf8', start, end)
    if (!text.trim()) {
      stats.blank++
      return
    }
    stats.nonBlank++
    let record: unknown
    try {
      record = JSON.parse(text)
    } catch {
      if (terminated) stats.badLines++
      else stats.truncatedTail = true
      return
    }
    if (!terminated) stats.finalNewlineMissing = true
    stats.parseable++
    const view = buffer.subarray(start, contentEnd)
    const lineSeparator = view.indexOf(LINE_SEPARATOR) !== -1 || view.indexOf(PARAGRAPH_SEPARATOR) !== -1
    const bareCr = view.indexOf(0x0d) !== -1
    if (lineSeparator) stats.lineSeparatorRecords++
    if (bareCr) stats.bareCrRecords++
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
      stats.nonObjectRecords++
    } else {
      const typeName = sanitizeTypeName((record as { type?: unknown }).type)
      stats.recordTypes[typeName] = (stats.recordTypes[typeName] || 0) + 1
    }
    visit?.(record, { lineIndex: index, lineSeparator, bareCr })
  }

  const stream = fs.createReadStream(filePath, { highWaterMark: options.highWaterMark ?? 4 * 1024 * 1024 })
  let pending: Buffer[] = []
  let pendingLength = 0
  try {
    for await (const chunk of stream as AsyncIterable<Buffer>) {
      if (options.signal?.aborted) throw abortError()
      stats.bytesRead += chunk.length
      let start = 0
      let newline: number
      while ((newline = chunk.indexOf(0x0a, start)) !== -1) {
        if (pendingLength > 0) {
          pending.push(chunk.subarray(start, newline))
          const line = Buffer.concat(pending, pendingLength + (newline - start))
          pending = []
          pendingLength = 0
          processLine(line, 0, line.length, true)
        } else {
          processLine(chunk, start, newline, true)
        }
        start = newline + 1
      }
      if (start < chunk.length) {
        pending.push(chunk.subarray(start))
        pendingLength += chunk.length - start
      }
    }
    if (pendingLength > 0) {
      const line = Buffer.concat(pending, pendingLength)
      processLine(line, 0, line.length, false)
    }
  } finally {
    stream.destroy()
  }
  return stats
}
