/**
 * Canonical JSONL reader for the legacy Claude Code, Codex and Cursor parsers.
 *
 * It replaces `node:readline`, which also ends a line at U+2028 / U+2029 and
 * at a lone CR. JSON allows U+2028 / U+2029 unescaped inside strings, so
 * readline cut such a record in two; both halves failed JSON.parse and were
 * dropped without being counted. This reader splits at LF only and reports
 * what it read (JsonlReadStats).
 *
 * Behaviour matches the readline + `encoding: 'utf-8'` reader it replaces,
 * with exactly two differences (marked "differs"):
 * - A line ends at LF (0x0A). One CR (0x0D) right before the LF, or right
 *   before the end of the file, is dropped, so CRLF files read as before.
 * - differs: U+2028 / U+2029 no longer end a line. U+0085 never did.
 * - differs: a lone CR no longer ends a line. A raw CR cannot occur inside a
 *   JSON string, so this only affects lines that were already malformed.
 * - A line's bytes are joined once and decoded as UTF-8 without `fatal`:
 *   malformed bytes become U+FFFD and a leading BOM is kept, as before.
 * - A line is blank when `!line.trim()`. Blank lines are skipped and not
 *   counted.
 * - Only the line being assembled is buffered, never the file. Callers still
 *   collect every record, as they did before.
 *
 * Kernel candidate: depends on Node built-ins only and imports nothing from
 * src/**. By design it shares no code with the checkup census reader.
 */
import { createReadStream } from 'node:fs'

const LF = 0x0a
const CR = 0x0d

/** Per-file counts; the three legacy parsers report the same fields. */
export interface JsonlReadStats {
  /** Non-blank physical lines (split at LF only) that were read completely. */
  nonBlankLines: number
  /** Lines that JSON.parse accepted; each became one returned record. */
  recordsRead: number
  /**
   * Non-blank lines that JSON.parse rejected, a partial tail included. Split
   * at LF, one bad line loses at most one record.
   */
  badLines: number
  /** Records lost, counted per record: equals badLines. A lower bound when truncated. */
  recordsLost: number
  /**
   * The last line had no terminating LF and did not parse (usually a file
   * that is still being written). It is also counted in badLines.
   */
  partialTail: boolean
  /**
   * Reading stopped early: the timeout fired, or the stream failed while
   * `onStreamError` is 'truncate'. The counts cover only what was read.
   */
  truncated: boolean
}

export interface JsonlReadOptions {
  /** Stop after this many milliseconds and resolve what was read, with truncated = true. */
  timeoutMs?: number
  /**
   * What a stream error (missing file, read failure) does. 'throw' rejects
   * with the error. 'truncate' resolves what was read, with truncated = true.
   * Default 'throw'.
   */
  onStreamError?: 'throw' | 'truncate'
  /** Read chunk size in bytes. Tests shrink it to force splits at chunk boundaries. */
  highWaterMark?: number
}

export type JsonlRecords<T> = { records: T[] } & JsonlReadStats

type LineHandler = (line: string, terminated: boolean) => void

interface LineSplitter {
  write(chunk: Buffer): void
  /** Emits the last line when the file does not end with LF. */
  end(): void
}

/**
 * Splits a byte stream at LF. A line that fits in one chunk is decoded in
 * place. A line that spans chunks is kept as a list of chunk slices and
 * joined once, when its LF arrives, so a very long line costs linear time
 * rather than one copy of the whole line per chunk.
 */
function createLineSplitter(onLine: LineHandler): LineSplitter {
  let parts: Buffer[] = []
  let partsLength = 0

  const emit = (bytes: Buffer, start: number, end: number, terminated: boolean): void => {
    const stop = end > start && bytes[end - 1] === CR ? end - 1 : end
    onLine(bytes.toString('utf8', start, stop), terminated)
  }

  const takeParts = (): Buffer => {
    const joined = parts.length === 1 ? parts[0] : Buffer.concat(parts, partsLength)
    parts = []
    partsLength = 0
    return joined
  }

  return {
    write(chunk: Buffer): void {
      let start = 0
      let lf = chunk.indexOf(LF)
      while (lf !== -1) {
        if (parts.length === 0) {
          emit(chunk, start, lf, true)
        } else {
          if (lf > start) {
            parts.push(chunk.subarray(start, lf))
            partsLength += lf - start
          }
          const line = takeParts()
          emit(line, 0, line.length, true)
        }
        start = lf + 1
        lf = chunk.indexOf(LF, start)
      }
      if (start < chunk.length) {
        parts.push(start === 0 ? chunk : chunk.subarray(start))
        partsLength += chunk.length - start
      }
    },
    end(): void {
      if (parts.length === 0) return
      const line = takeParts()
      emit(line, 0, line.length, false)
    }
  }
}

/**
 * Reads a JSONL file and returns every line that JSON.parse accepts, in file
 * order, together with the per-file counts.
 */
export function readJsonlRecords<T = unknown>(
  filePath: string,
  options: JsonlReadOptions = {}
): Promise<JsonlRecords<T>> {
  const records: T[] = []
  const stats: JsonlReadStats = {
    nonBlankLines: 0,
    recordsRead: 0,
    badLines: 0,
    recordsLost: 0,
    partialTail: false,
    truncated: false
  }

  const acceptLine: LineHandler = (line, terminated) => {
    if (!line.trim()) return
    stats.nonBlankLines++
    let record: T
    try {
      record = JSON.parse(line) as T
    } catch {
      stats.badLines++
      stats.recordsLost++
      if (!terminated) stats.partialTail = true
      return
    }
    records.push(record)
    stats.recordsRead++
  }

  return new Promise<JsonlRecords<T>>((resolve, reject) => {
    const stream = createReadStream(
      filePath,
      options.highWaterMark === undefined ? {} : { highWaterMark: options.highWaterMark }
    )
    const splitter = createLineSplitter(acceptLine)
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined

    const settle = (): boolean => {
      if (settled) return false
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      return true
    }
    const finish = (truncated: boolean): void => {
      if (!settle()) return
      stats.truncated = truncated
      resolve({ records, ...stats })
    }

    if (options.timeoutMs !== undefined) {
      timer = setTimeout(() => {
        stream.destroy()
        finish(true)
      }, options.timeoutMs)
    }

    stream.on('data', (chunk) => {
      if (!settled) splitter.write(chunk as Buffer)
    })
    stream.on('end', () => {
      if (settled) return
      splitter.end()
      finish(false)
    })
    stream.on('error', (error) => {
      if (options.onStreamError === 'truncate') {
        finish(true)
      } else if (settle()) {
        reject(error)
      }
    })
  })
}
