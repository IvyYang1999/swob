import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { initLibrary, scanLibrary } from '../main/library-manager'
import { shellQuote } from '../main/resume-terminal'
import { buildCliResumeResponse } from './resume-command'

// CLI 的 parseArgs 是内部函数，这里用同样的逻辑来测试
function parseArgs(argv: string[]): { cmd: string[]; flags: Record<string, string | true> } {
  const cmd: string[] = []
  const flags: Record<string, string | true> = {}
  let i = 0
  while (i < argv.length) {
    const arg = argv[i]
    if (arg.startsWith('--')) {
      const key = arg.slice(2)
      const next = argv[i + 1]
      if (next && !next.startsWith('--')) {
        flags[key] = next
        i += 2
      } else {
        flags[key] = true
        i += 1
      }
    } else {
      cmd.push(arg)
      i += 1
    }
  }
  return { cmd, flags }
}

describe('CLI parseArgs', () => {
  it('解析纯命令', () => {
    const { cmd, flags } = parseArgs(['search', 'hello', 'world'])
    expect(cmd).toEqual(['search', 'hello', 'world'])
    expect(flags).toEqual({})
  })

  it('解析带值的 flag', () => {
    const { cmd, flags } = parseArgs(['list', '--folder', 'swob', '--limit', '10'])
    expect(cmd).toEqual(['list'])
    expect(flags.folder).toBe('swob')
    expect(flags.limit).toBe('10')
  })

  it('解析布尔 flag', () => {
    const { cmd, flags } = parseArgs(['resume', 'abc-123', '--skip-permissions', '--json'])
    expect(cmd).toEqual(['resume', 'abc-123'])
    expect(flags['skip-permissions']).toBe(true)
    expect(flags.json).toBe(true)
  })

  it('flag 值不会被下一个 flag 吃掉', () => {
    const { flags } = parseArgs(['--help', '--json'])
    expect(flags.help).toBe(true)
    expect(flags.json).toBe(true)
  })

  it('空参数返回空结果', () => {
    const { cmd, flags } = parseArgs([])
    expect(cmd).toEqual([])
    expect(flags).toEqual({})
  })

  it('混合命令和 flag', () => {
    const { cmd, flags } = parseArgs(['folder', 'create', '我的项目', '--parent', 'swob/主开发'])
    expect(cmd).toEqual(['folder', 'create', '我的项目'])
    expect(flags.parent).toBe('swob/主开发')
  })

  it('【曾经的 bug】transcript rebuild 解析 --missing-only flag', () => {
    const { cmd, flags } = parseArgs(['transcript', 'rebuild', '--all', '--missing-only'])
    expect(cmd).toEqual(['transcript', 'rebuild'])
    expect(flags.all).toBe(true)
    expect(flags['missing-only']).toBe(true)
  })
})

describe('CLI formatTokens', () => {
  function formatTokens(n: number): string {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
    return String(n)
  }

  it('小数值直接返回', () => {
    expect(formatTokens(0)).toBe('0')
    expect(formatTokens(999)).toBe('999')
  })

  it('千级别用 k', () => {
    expect(formatTokens(1000)).toBe('1.0k')
    expect(formatTokens(1500)).toBe('1.5k')
    expect(formatTokens(999999)).toBe('1000.0k')
  })

  it('百万级别用 M', () => {
    expect(formatTokens(1_000_000)).toBe('1.0M')
    expect(formatTokens(5_500_000)).toBe('5.5M')
  })
})

describe('CLI formatTime', () => {
  function formatTime(ms: number): string {
    if (ms < 60_000) return `${Math.round(ms / 1000)}s`
    if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`
    return `${(ms / 3_600_000).toFixed(1)}h`
  }

  it('秒级别', () => {
    expect(formatTime(5000)).toBe('5s')
    expect(formatTime(59999)).toBe('60s')
  })

  it('分钟级别', () => {
    expect(formatTime(60_000)).toBe('1m')
    expect(formatTime(300_000)).toBe('5m')
  })

  it('小时级别', () => {
    expect(formatTime(3_600_000)).toBe('1.0h')
    expect(formatTime(5_400_000)).toBe('1.5h')
  })
})

describe('CLI resume guard', () => {
  let tmpRoot: string

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-cli-resume-'))
    initLibrary(tmpRoot)
  })

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  })

  function writeLibraryBackupOnlySession(sessionId: string): void {
    const dirPath = path.join(tmpRoot, sessionId)
    fs.mkdirSync(dirPath, { recursive: true })
    fs.writeFileSync(path.join(dirPath, '.swob-session.json'), JSON.stringify({
      sessionId,
      sourceFilePaths: [`/Users/other-machine/.claude/projects/-Users-other-project/${sessionId}.jsonl`],
      createdAt: '2026-07-07T00:00:00Z',
      updatedAt: '2026-07-07T00:01:00Z',
      projectPath: '/Users/other-machine/project'
    }, null, 2), 'utf-8')
    fs.writeFileSync(path.join(dirPath, 'backup.jsonl'), JSON.stringify({
      uuid: `${sessionId}-u1`,
      sessionId,
      type: 'user',
      timestamp: '2026-07-07T00:00:00Z',
      message: { role: 'user', content: 'hello' }
    }) + '\n', 'utf-8')
    scanLibrary()
  }

  it('Library-only backup-only id 返回 error，不拼 ad-hoc 假命令', async () => {
    writeLibraryBackupOnlySession('remote-only-999')

    const result = await buildCliResumeResponse('remote-only-999', {}, {
      loadSessions: async () => []
    })

    expect(result).toEqual({ error: 'This session cannot be resumed directly' })
  })

  it('完全 unknown 的 ad-hoc id 仍保留兼容命令', async () => {
    scanLibrary()

    const result = await buildCliResumeResponse('totally-unknown-999', {}, {
      loadSessions: async () => []
    })

    expect(result).toEqual({ command: `claude --resume ${shellQuote('totally-unknown-999')}` })
  })
})
