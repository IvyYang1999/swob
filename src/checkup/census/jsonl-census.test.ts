import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as readline from 'node:readline'
import { afterEach, describe, expect, it } from 'vitest'
import { MISSING_TYPE, UNRECOGNIZED_TYPE, readJsonlFile, sanitizeTypeName } from './jsonl-census'

const LS = String.fromCharCode(0x2028)
const PS = String.fromCharCode(0x2029)
const dirs: string[] = []

function write(content: string | Buffer): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsonl-census-'))
  dirs.push(dir)
  const file = path.join(dir, 'sample.jsonl')
  fs.writeFileSync(file, content)
  return file
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('spec JSONL reader', () => {
  it('splits only on \\n: raw U+2028/U+2029 stay inside one record', async () => {
    const file = write([
      JSON.stringify({ type: 'user', text: `a${LS}b` }),
      JSON.stringify({ type: 'assistant', text: `c${PS}d` }),
      JSON.stringify({ type: 'user', text: 'plain' })
    ].join('\n') + '\n')
    const seen: boolean[] = []
    const stats = await readJsonlFile(file, (_record, meta) => { seen.push(meta.lineSeparator) })
    expect(stats).toMatchObject({ lines: 3, nonBlank: 3, parseable: 3, badLines: 0, lineSeparatorRecords: 2, truncatedTail: false })
    expect(seen).toEqual([true, true, false])
  })

  it('does not count the escaped \\u2028 form as a raw separator', async () => {
    const file = write('{"type":"user","text":"a\\u2028b"}\n{"type":"user","text":"x\\u2029y"}\n')
    const stats = await readJsonlFile(file)
    expect(stats.parseable).toBe(2)
    expect(stats.lineSeparatorRecords).toBe(0)
  })

  it('documents the readline hazard: the same file loses the raw-separator record under readline', async () => {
    const file = write(`${JSON.stringify({ type: 'user', text: `a${LS}b` })}\n${JSON.stringify({ type: 'user' })}\n`)
    let parsedByReadline = 0
    const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity })
    for await (const line of rl) {
      try { JSON.parse(line); parsedByReadline++ } catch { /* split fragment */ }
    }
    const stats = await readJsonlFile(file)
    expect(stats.parseable).toBe(2)
    expect(parsedByReadline).toBe(1)
  })

  it('counts real bad lines separately from a truncated tail', async () => {
    const file = write('{"type":"user"}\n{"type":"user",\n{"type":"assistant"}\n{"type":"assis')
    const stats = await readJsonlFile(file)
    expect(stats).toMatchObject({ lines: 4, nonBlank: 4, parseable: 2, badLines: 1, truncatedTail: true, finalNewlineMissing: false })
  })

  it('treats a parseable unterminated last line as complete (not truncated)', async () => {
    const file = write('{"type":"user"}\n{"type":"assistant"}')
    const stats = await readJsonlFile(file)
    expect(stats).toMatchObject({ parseable: 2, truncatedTail: false, finalNewlineMissing: true })
  })

  it('handles CRLF endings, bare CR inside a record and blank lines', async () => {
    const file = write('{"type":"user"}\r\n\r\n   \n{"type":"assistant",\r"x":1}\n')
    const stats = await readJsonlFile(file)
    expect(stats).toMatchObject({ lines: 4, blank: 2, nonBlank: 2, parseable: 2, crlfLines: 2, bareCrRecords: 1, badLines: 0 })
  })

  it('reassembles lines that span many small chunks', async () => {
    const long = { type: 'assistant', text: `${'x'.repeat(5000)}${LS}${'y'.repeat(5000)}` }
    const file = write(`${JSON.stringify(long)}\n${JSON.stringify({ type: 'user' })}\n`)
    const stats = await readJsonlFile(file, undefined, { highWaterMark: 17 })
    expect(stats).toMatchObject({ lines: 2, parseable: 2, lineSeparatorRecords: 1, badLines: 0 })
    expect(stats.bytesRead).toBe(fs.statSync(file).size)
  })

  it('reports only sanitised record type names', async () => {
    const file = write([
      JSON.stringify({ type: 'queue-operation' }),
      JSON.stringify({ type: 'has space in it' }),
      JSON.stringify({ noType: true }),
      JSON.stringify([1, 2]),
      JSON.stringify({ type: 'x'.repeat(60) })
    ].join('\n') + '\n')
    const stats = await readJsonlFile(file)
    expect(stats.recordTypes).toEqual({ 'queue-operation': 1, [UNRECOGNIZED_TYPE]: 2, [MISSING_TYPE]: 1 })
    expect(stats.nonObjectRecords).toBe(1)
    expect(sanitizeTypeName('event_msg')).toBe('event_msg')
    expect(sanitizeTypeName('/Users/x')).toBe(UNRECOGNIZED_TYPE)
  })

  it('returns zero counts for an empty file and honours abort signals', async () => {
    const empty = write('')
    expect(await readJsonlFile(empty)).toMatchObject({ lines: 0, parseable: 0, bytesRead: 0 })
    const file = write('{"type":"user"}\n')
    const controller = new AbortController()
    controller.abort()
    await expect(readJsonlFile(file, undefined, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' })
  })
})
