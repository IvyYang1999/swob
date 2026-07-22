import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { OnboardingBackupSizeEstimator } from './onboarding-backup-size'
import type { SessionSummary } from './types'

let tempRoot = ''

function writeSizedFile(relativePath: string, bytes: number): string {
  const filePath = path.join(tempRoot, relativePath)
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, Buffer.alloc(bytes, 1))
  return filePath
}

function session(
  sessionId: string,
  source: SessionSummary['source'],
  filePaths: string[],
  id = sessionId
): SessionSummary {
  return {
    id,
    sessionId,
    source,
    filePath: filePaths[0] || '',
    allFilePaths: filePaths,
    updatedAt: '2026-07-22T00:00:00.000Z'
  } as SessionSummary
}

beforeEach(() => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-onboarding-size-'))
})

afterEach(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true })
})

describe('onboarding backup size estimator', () => {
  it('按逻辑会话去重分支，并按真实拼接规则统计多文件会话', () => {
    const first = writeSizedFile('.claude/projects/demo/first.jsonl', 10)
    const continuation = writeSizedFile('.claude/projects/demo/continuation.jsonl', 20)
    const codex = writeSizedFile('.codex/sessions/2026/codex.jsonl', 7)
    const estimator = new OnboardingBackupSizeEstimator()

    const result = estimator.estimate({
      sessions: [
        session('logical-claude', 'claude-code', [first, continuation]),
        session('logical-claude', 'claude-code', [first, continuation], 'logical-claude:intra-1'),
        session('logical-codex', 'codex', [codex])
      ],
      excludedSources: [],
      targetPath: path.join(tempRoot, 'new-library')
    })

    expect(result.perSource).toEqual([
      { source: 'claude-code', sessions: 1, bytes: 33 },
      { source: 'codex', sessions: 1, bytes: 8 }
    ])
    expect(result.totalBytes).toBe(41)
    expect(result.targetIsExistingLibrary).toBe(false)
    expect(result).not.toHaveProperty('estimatedNewBytes')
  })

  it('排除来源会同步改变来源明细、会话数和总容量', () => {
    const claude = writeSizedFile('.claude/projects/demo/claude.jsonl', 12)
    const codex = writeSizedFile('.codex/sessions/2026/codex.jsonl', 8)
    const estimator = new OnboardingBackupSizeEstimator()
    const sessions = [
      session('claude-1', 'claude-code', [claude]),
      session('codex-1', 'codex', [codex])
    ]

    const all = estimator.estimate({ sessions, excludedSources: [], targetPath: tempRoot })
    const withoutCodex = estimator.estimate({ sessions, excludedSources: ['codex'], targetPath: tempRoot })

    expect(all.totalBytes).toBe(22)
    expect(withoutCodex.perSource).toEqual([{ source: 'claude-code', sessions: 1, bytes: 13 }])
    expect(withoutCodex.totalBytes).toBe(13)
  })

  it('已有 Library 只返回同一逻辑会话的增长量与全新会话大小', () => {
    const library = path.join(tempRoot, 'Library')
    const existingPackage = path.join(library, 'existing-package')
    fs.mkdirSync(existingPackage, { recursive: true })
    fs.writeFileSync(path.join(library, '.swob-config.json'), '{}')
    fs.writeFileSync(path.join(existingPackage, '.swob-session.json'), JSON.stringify({ sessionId: 'existing' }))
    fs.writeFileSync(path.join(existingPackage, 'backup.jsonl'), Buffer.alloc(8_000))
    const existingPackageBytes = fs.readdirSync(existingPackage).reduce(
      (sum, name) => sum + fs.statSync(path.join(existingPackage, name)).size,
      0
    )
    const grown = writeSizedFile('.claude/projects/demo/grown.jsonl', 12_000)
    const fresh = writeSizedFile('.claude/projects/demo/fresh.jsonl', 5_000)

    const result = new OnboardingBackupSizeEstimator().estimate({
      sessions: [
        session('existing', 'claude-code', [grown]),
        session('fresh', 'claude-code', [fresh])
      ],
      excludedSources: [],
      targetPath: library
    })

    expect(result).toMatchObject({
      targetIsExistingLibrary: true,
      totalBytes: 17_901,
      estimatedNewBytes: 17_901 - existingPackageBytes
    })
  })

  it('缓存 60 秒，完成阶段 forceRefresh 会重读活跃会话大小', () => {
    const active = writeSizedFile('.claude/projects/demo/active.jsonl', 5)
    const estimator = new OnboardingBackupSizeEstimator()
    const options = {
      sessions: [session('active', 'claude-code', [active])],
      excludedSources: [],
      targetPath: tempRoot
    }

    expect(estimator.estimate(options).totalBytes).toBe(6)
    fs.appendFileSync(active, Buffer.alloc(3))
    expect(estimator.estimate(options).totalBytes).toBe(6)
    expect(estimator.estimate({ ...options, forceRefresh: true }).totalBytes).toBe(9)
  })

  it('1700 个会话只 stat 源文件并在 2 秒内完成', () => {
    const sessions = Array.from({ length: 1700 }, (_, index) => {
      const filePath = writeSizedFile(`.claude/projects/demo/session-${index}.jsonl`, 4)
      return session(`session-${index}`, 'claude-code', [filePath])
    })
    const startedAt = performance.now()
    const result = new OnboardingBackupSizeEstimator().estimate({
      sessions,
      excludedSources: [],
      targetPath: tempRoot
    })
    const elapsedMs = performance.now() - startedAt

    expect(result.totalBytes).toBe(7_161)
    expect(result.perSource[0].sessions).toBe(1700)
    expect(elapsedMs).toBeLessThan(2_000)
  }, 10_000)
})
