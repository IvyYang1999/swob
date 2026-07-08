import { describe, expect, it } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { detectSessionSourceForJsonl } from './session-source'

function writeBackupJsonl(rows: unknown[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-source-test-'))
  const filePath = path.join(dir, 'backup.jsonl')
  fs.writeFileSync(filePath, rows.map((row) => JSON.stringify(row)).join('\n'))
  return filePath
}

describe('detectSessionSourceForJsonl', () => {
  it('backup/detail 场景 source path 与内容冲突时优先嗅探内容', () => {
    const backupPath = writeBackupJsonl([
      { role: 'user', message: { content: 'Cursor backup content' } }
    ])

    const source = detectSessionSourceForJsonl(backupPath, [
      '/Users/test/.codex/sessions/2026/07/07/rollout-2026-07-07T00-00-00-00000000-0000-4000-8000-000000000000.jsonl'
    ])

    expect(source).toBe('cursor')
  })

  it('transcript 场景 source path 与内容冲突时优先信 meta.sourceFilePaths[0]', () => {
    const backupPath = writeBackupJsonl([
      { role: 'user', message: { content: 'Cursor backup content' } }
    ])

    const source = detectSessionSourceForJsonl(
      backupPath,
      ['/Users/test/.codex/sessions/2026/07/07/rollout-2026-07-07T00-00-00-00000000-0000-4000-8000-000000000000.jsonl'],
      { preferSourcePaths: true }
    )

    expect(source).toBe('codex')
  })
})
