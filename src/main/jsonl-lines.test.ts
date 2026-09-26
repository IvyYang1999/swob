import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as readline from 'node:readline'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readJsonlRecords, type JsonlReadStats } from './jsonl-lines'

// All fixtures are synthetic and live below os.tmpdir(), which the Vitest
// setup (isolate-home.ts) points into the per-run sandbox.
const dirs: string[] = []

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-jsonl-lines-'))
  dirs.push(dir)
  return dir
}

function tempFile(content: string | Buffer): string {
  const file = path.join(tempDir(), 'transcript.jsonl')
  fs.writeFileSync(file, content)
  return file
}

function jsonl(records: unknown[], eol = '\n'): string {
  return records.map((record) => JSON.stringify(record) + eol).join('')
}

function stats(overrides: Partial<JsonlReadStats> = {}): JsonlReadStats {
  return {
    nonBlankLines: 0,
    recordsRead: 0,
    badLines: 0,
    recordsLost: 0,
    partialTail: false,
    truncated: false,
    ...overrides
  }
}

function statsOf(result: { records: unknown[] } & JsonlReadStats): JsonlReadStats {
  const { records: _records, ...rest } = result
  return rest
}

/** The reader this module replaced: readline over a utf-8 stream. */
async function readWithReadline(file: string, highWaterMark?: number): Promise<{ lines: number; records: unknown[] }> {
  const stream = fs.createReadStream(file, highWaterMark === undefined
    ? { encoding: 'utf-8' }
    : { encoding: 'utf-8', highWaterMark })
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity })
  const records: unknown[] = []
  let lines = 0
  for await (const line of rl) {
    if (!line.trim()) continue
    lines++
    try {
      records.push(JSON.parse(line))
    } catch { /* skipped, as the old parsers did */ }
  }
  return { lines, records }
}

const RAW_LS = Buffer.from([0xe2, 0x80, 0xa8]) // U+2028 LINE SEPARATOR
const RAW_PS = Buffer.from([0xe2, 0x80, 0xa9]) // U+2029 PARAGRAPH SEPARATOR

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('readJsonlRecords: line splitting', () => {
  it('reads records holding raw U+2028 / U+2029 whole (readline cut each in two)', async () => {
    const records = [
      { type: 'user', text: '第一行 第二行' },
      { type: 'assistant', text: '段一 段二' },
      { type: 'user', text: 'plain' }
    ]
    const content = Buffer.from(jsonl(records), 'utf8')
    // JSON.stringify leaves U+2028 / U+2029 unescaped, so the raw bytes are on disk.
    expect(content.includes(RAW_LS)).toBe(true)
    expect(content.includes(RAW_PS)).toBe(true)
    const file = tempFile(content)

    const result = await readJsonlRecords(file)
    expect(result.records).toEqual(records)
    expect(statsOf(result)).toEqual(stats({ nonBlankLines: 3, recordsRead: 3 }))

    // Control: the old reader sees 5 fragments and keeps only the plain record.
    expect(await readWithReadline(file)).toEqual({ lines: 5, records: [records[2]] })
  })

  it('parses the escaped \\u2028 form and keeps U+0085 inside the line', async () => {
    const content = Buffer.from('{"text":"a\\u2028b"}\n' + JSON.stringify({ text: 'x\u0085y' }) + '\n', 'utf8')
    expect(content.includes(RAW_LS)).toBe(false)
    expect(content.includes(Buffer.from([0xc2, 0x85]))).toBe(true)

    const result = await readJsonlRecords(tempFile(content))
    expect(result.records).toEqual([{ text: 'a b' }, { text: 'x\u0085y' }])
    expect(statsOf(result)).toEqual(stats({ nonBlankLines: 2, recordsRead: 2 }))
  })

  it('drops one CR before LF, including when CR and LF land in different chunks', async () => {
    const records = [{ a: 1 }, { b: '中文' }, { c: [1, 2, 3] }]
    const file = tempFile(jsonl(records, '\r\n'))
    for (const highWaterMark of [undefined, 1, 2, 3, 5, 8]) {
      const result = await readJsonlRecords(file, { highWaterMark })
      expect(result.records, `highWaterMark=${highWaterMark}`).toEqual(records)
      expect(statsOf(result)).toEqual(stats({ nonBlankLines: 3, recordsRead: 3 }))
    }
  })

  it('skips blank lines without counting them', async () => {
    const content = '\n   \n\t\r\n \n \n' + jsonl([{ a: 1 }]) + '\n\n' + jsonl([{ b: 2 }]) + '  '
    const result = await readJsonlRecords(tempFile(content))
    expect(result.records).toEqual([{ a: 1 }, { b: 2 }])
    expect(statsOf(result)).toEqual(stats({ nonBlankLines: 2, recordsRead: 2 }))
  })

  it('reads an empty file as zero records', async () => {
    const result = await readJsonlRecords(tempFile(''))
    expect(result).toEqual({ records: [], ...stats() })
  })

  it('a lone CR no longer ends a line (the second intended difference from readline)', async () => {
    // Two records glued by a lone CR were two lines for readline; split at LF
    // they are one malformed line.
    const glued = await readJsonlRecords(tempFile('{"a":1}\r{"b":2}\n'))
    expect(glued.records).toEqual([])
    expect(statsOf(glued)).toEqual(stats({ nonBlankLines: 1, badLines: 1, recordsLost: 1 }))

    // A raw CR between JSON tokens is whitespace, so the record now parses.
    const inner = await readJsonlRecords(tempFile('{"a":\r1}\n'))
    expect(inner.records).toEqual([{ a: 1 }])
  })
})

describe('readJsonlRecords: bad lines and the tail', () => {
  it('counts a malformed line as bad and keeps reading', async () => {
    const content = jsonl([{ a: 1 }]) + '{"type":"user","message":\n' + jsonl([{ b: 2 }])
    const result = await readJsonlRecords(tempFile(content))
    expect(result.records).toEqual([{ a: 1 }, { b: 2 }])
    expect(statsOf(result)).toEqual(stats({ nonBlankLines: 3, recordsRead: 2, badLines: 1, recordsLost: 1 }))
  })

  it('flags an unterminated last line that does not parse as a partial tail', async () => {
    const content = jsonl([{ a: 1 }]) + '{"type":"assistant","mess'
    const result = await readJsonlRecords(tempFile(content))
    expect(result.records).toEqual([{ a: 1 }])
    expect(statsOf(result)).toEqual(stats({
      nonBlankLines: 2, recordsRead: 1, badLines: 1, recordsLost: 1, partialTail: true
    }))
  })

  it('reads an unterminated last line that parses as a record, not a partial tail', async () => {
    const content = jsonl([{ a: 1 }]) + JSON.stringify({ b: 2 })
    const result = await readJsonlRecords(tempFile(content))
    expect(result.records).toEqual([{ a: 1 }, { b: 2 }])
    expect(statsOf(result)).toEqual(stats({ nonBlankLines: 2, recordsRead: 2 }))
  })
})

describe('readJsonlRecords: chunks and decoding', () => {
  it('reads lines longer than the stream chunk', async () => {
    const records = [
      { n: 0 },
      { n: 1, text: 'a'.repeat(1024 * 1024) },
      { n: 2, text: '长'.repeat(100_000) + ' ' },
      { n: 3 }
    ]
    const file = tempFile(jsonl(records))
    // Default chunk (64 KiB) and a small one.
    for (const highWaterMark of [undefined, 4096]) {
      const result = await readJsonlRecords(file, { highWaterMark })
      expect(result.records).toEqual(records)
      expect(statsOf(result)).toEqual(stats({ nonBlankLines: 4, recordsRead: 4 }))
    }
  })

  it('decodes multi-byte characters split across chunk boundaries', async () => {
    const text = 'é中😀  '.repeat(3)
    const records = [{ text }, { text: `x${text}` }, { text: `xy${text}` }]
    const file = tempFile(jsonl(records))
    for (const highWaterMark of [1, 2, 3, 4, 5, 6, 7]) {
      const result = await readJsonlRecords(file, { highWaterMark })
      expect(result.records, `highWaterMark=${highWaterMark}`).toEqual(records)
    }
  })

  it('joins the bytes of a line that spans many chunks once', async () => {
    const record = { text: '长'.repeat(20_000) }
    const file = tempFile(jsonl([record]))
    const lineBytes = fs.statSync(file).size - 1
    const concat = vi.spyOn(Buffer, 'concat')

    const result = await readJsonlRecords(file, { highWaterMark: 16 })
    expect(result.records).toEqual([record])
    // One join for the only line, over the slices of every chunk it touched;
    // never a re-concatenation per chunk (quadratic on long lines).
    expect(concat).toHaveBeenCalledTimes(1)
    const slices = concat.mock.calls[0][0] as readonly Uint8Array[]
    expect(slices.length).toBeGreaterThan(1_000)
    expect(slices.reduce((sum, slice) => sum + slice.length, 0)).toBe(lineBytes)
  })

  it('replaces malformed UTF-8 with U+FFFD instead of failing', async () => {
    const line = Buffer.concat([Buffer.from('{"t":"a'), Buffer.from([0xff, 0xe2, 0x80]), Buffer.from('b"}\n')])
    const expected = JSON.parse(line.toString('utf8'))
    expect(expected.t).toContain('�')
    const file = tempFile(line)
    for (const highWaterMark of [undefined, 1, 7, 8]) {
      const result = await readJsonlRecords(file, { highWaterMark })
      expect(result.records).toEqual([expected])
    }
  })

  it('matches the readline reader on input without U+2028 / U+2029 / lone CR', async () => {
    // Everything but the two intended differences: CRLF, blank and
    // whitespace-only lines, U+0085, a leading BOM (kept, so that first line
    // stays unparseable as before), malformed UTF-8, a malformed line, long
    // lines and an unterminated tail.
    const invalid = [[0xff], [0xe2, 0x80], [0xf0, 0x9f, 0x98], [0xc3], [0x80], [0xed, 0xa0, 0x80], [0xf4, 0x90, 0x80, 0x80]]
    const corpus: Buffer[] = [
      Buffer.from('﻿' + jsonl([{ first: 'bom' }, { second: 1 }]), 'utf8'),
      Buffer.from('\n\n  \n' + jsonl([{ a: 'x\u0085y' }], '\r\n') + '\r\n\t\n' + JSON.stringify({ tail: true }), 'utf8'),
      Buffer.from(jsonl([{ a: 1 }]) + '{"broken":\n' + jsonl([{ c: 3 }]) + '{"tail":', 'utf8'),
      Buffer.from(jsonl([{ long: 'z'.repeat(70_000) }, { cjk: '中'.repeat(30_000) }]), 'utf8'),
      ...invalid.map((bytes) => Buffer.concat([
        Buffer.from('{"t":"a'), Buffer.from(bytes), Buffer.from('中b"}\n{"u":"😀"}\r\n')
      ]))
    ]
    for (const [index, content] of corpus.entries()) {
      const file = tempFile(content)
      // Tiny chunks only on the small inputs; the long lines need no byte-sized reads.
      const chunkSizes = content.length > 10_000 ? [undefined, 4096] : [undefined, 1, 2, 3, 5, 7]
      for (const highWaterMark of chunkSizes) {
        const before = await readWithReadline(file, highWaterMark)
        const after = await readJsonlRecords(file, { highWaterMark })
        const label = `corpus[${index}] highWaterMark=${highWaterMark}`
        expect(after.records, label).toEqual(before.records)
        expect(after.nonBlankLines, label).toBe(before.lines)
      }
    }
  })
})

describe('readJsonlRecords: timeout and stream errors', () => {
  /** Lets a destroyed stream finish its in-flight read and close its fd. */
  async function settleIo(): Promise<void> {
    for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve))
  }

  it('stops at the timeout and resolves with truncated = true', async () => {
    const file = tempFile(jsonl([{ a: 1 }]))
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const pending = readJsonlRecords(file, { timeoutMs: 1_000 })
    // No I/O has run yet: the read is cut before its first chunk.
    vi.advanceTimersByTime(1_000)
    expect(await pending).toEqual({ records: [], ...stats({ truncated: true }) })
    await settleIo()
  })

  it('keeps the records read before the timeout and nothing after it', async () => {
    const all = Array.from({ length: 2_000 }, (_, i) => ({ i, pad: 'p'.repeat(100) }))
    const file = tempFile(jsonl(all))
    const parse = vi.spyOn(JSON, 'parse')
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const pending = readJsonlRecords<{ i: number }>(file, { timeoutMs: 5_000, highWaterMark: 1024 })
    // Wait until the first chunk has been parsed, then fire the timeout.
    const sawRecord = (): boolean => parse.mock.calls.some(([text]) => typeof text === 'string' && text.startsWith('{"i":'))
    while (!sawRecord()) await new Promise((resolve) => setImmediate(resolve))
    vi.advanceTimersByTime(5_000)

    const result = await pending
    const readCount = result.records.length
    expect(result.truncated).toBe(true)
    expect(readCount).toBeGreaterThan(0)
    expect(readCount).toBeLessThan(all.length)
    expect(result.records).toEqual(all.slice(0, readCount))
    expect(statsOf(result)).toEqual(stats({ nonBlankLines: readCount, recordsRead: readCount, truncated: true }))
    await settleIo()
    expect(result.records).toHaveLength(readCount)
  })

  it('rejects on a stream error by default', async () => {
    const dir = tempDir()
    await expect(readJsonlRecords(path.join(dir, 'missing.jsonl'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readJsonlRecords(dir, { onStreamError: 'throw' })).rejects.toMatchObject({ code: 'EISDIR' })
  })

  it("resolves with truncated = true on a stream error when onStreamError is 'truncate'", async () => {
    const dir = tempDir()
    expect(await readJsonlRecords(path.join(dir, 'missing.jsonl'), { onStreamError: 'truncate' }))
      .toEqual({ records: [], ...stats({ truncated: true }) })
    expect(await readJsonlRecords(dir, { onStreamError: 'truncate' }))
      .toEqual({ records: [], ...stats({ truncated: true }) })
  })
})
