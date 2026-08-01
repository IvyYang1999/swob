import { describe, expect, it } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { detectSessionSourceForJsonl, detectSessionSourceFromPath } from './session-source'

function writeBackupJsonl(rows: unknown[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-source-test-'))
  const filePath = path.join(dir, 'backup.jsonl')
  fs.writeFileSync(filePath, rows.map((row) => JSON.stringify(row)).join('\n'))
  return filePath
}

describe('detectSessionSourceForJsonl', () => {
  it('Windows 反斜杠路径也能识别 Alpha 来源', () => {
    expect(detectSessionSourceFromPath('C:\\Users\\Alice\\.claude\\projects\\demo\\a.jsonl')).toBe('claude-code')
    expect(detectSessionSourceFromPath('C:\\Users\\Alice\\.codex\\sessions\\2026\\a.jsonl')).toBe('codex')
  })

  it('opencode DB source ref 按路径识别来源', () => {
    const source = detectSessionSourceFromPath('/Users/test/.local/share/opencode/opencode.db#ses_Abc123')

    expect(source).toBe('opencode')
  })

  it('Zcode 路径按 /.zcode/ 识别来源', () => {
    const source = detectSessionSourceFromPath('/Users/test/.zcode/cli/db/db.sqlite#sess_b3c1-with-hyphen')

    expect(source).toBe('zcode')
  })

  it('Kimi Code 新旧两个会话根都按路径识别', () => {
    expect(detectSessionSourceFromPath(
      '/Users/test/.kimi-code/sessions/workdir/session/agents/main/wire.jsonl'
    )).toBe('kimi')
    expect(detectSessionSourceFromPath(
      '/Users/test/.kimi/sessions/session/wire.jsonl'
    )).toBe('kimi')
  })

  it('Trae state.vscdb 虚拟会话定位符按产品目录识别来源', () => {
    expect(detectSessionSourceFromPath(
      '/Users/synthetic/Library/Application Support/Trae/User/workspaceStorage/hash/state.vscdb#session'
    )).toBe('trae')
    expect(detectSessionSourceFromPath(
      'C:\\Users\\synthetic\\Library\\Application Support\\TRAE SOLO CN\\User\\globalStorage\\state.vscdb#session'
    )).toBe('trae')
  })

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
