import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ResumeProbe, ResumeProbeInput } from '../contract'
import type { ClaudeParseResult, CodexParseResult, ReadoutSession, SwobReadout } from '../readout'
import type { CodexStateDb, CodexThreadRow } from '../census/codex-state-db'
import type { CheckContext } from './common'
import { locateProgram, resumeCheck } from './resume'

const dirs: string[] = []
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'checkup-resume-'))
  dirs.push(dir)
  return dir
}
function file(name: string): string {
  const target = path.join(tempDir(), name)
  fs.writeFileSync(target, 'x')
  return fs.realpathSync(target)
}
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function readout(sessions: ReadoutSession[], input: {
  claudeParsed?: Map<string, ClaudeParseResult>
  codexParsed?: Map<string, CodexParseResult>
  status?: SwobReadout['status']
  reason?: SwobReadout['reason']
} = {}): SwobReadout {
  return {
    status: input.status ?? 'ok',
    reason: input.reason,
    sessions,
    claudeParsed: input.claudeParsed ?? new Map(),
    codexParsed: input.codexParsed ?? new Map(),
    discovered: { claudeMain: new Set(), codex: new Set() },
    attributedChildIds: new Set(),
    consoleLines: 0,
    timingsMs: {}
  }
}

function ctx(partial: Partial<CheckContext> & Pick<CheckContext, 'readout'>): CheckContext {
  return {
    salt: 'resume-salt', selected: new Set(['claude-code', 'codex', 'cursor']),
    claude: { homes: [], roots: [{ fixedRoot: '~/.claude/projects', realPath: '/x' }], units: [], otherFiles: 0, otherBytes: 0, lowerSymlinks: 0, unreadableDirs: 0 } as never,
    codex: { homes: [], roots: [{ fixedRoot: '~/.codex/sessions', realPath: '/x' }], units: [], otherFiles: 0, otherBytes: 0, lowerSymlinks: 0, unreadableDirs: 0, codexHomeEnvSet: false, additionalHomes: 0 } as never,
    codexDb: null, unscanned: null, presence: [], changed: new Set(), resumeProbe: null,
    resumeSample: { perSource: 4, seed: '2026-09-28' },
    ...partial
  }
}

function claudeSession(sessionId: string, primaryPath: string | null, extra: Partial<ReadoutSession> = {}): ReadoutSession {
  return {
    source: 'claude-code', sessionId, primaryPath, paths: primaryPath ? [primaryPath] : [],
    subagentPaths: [], subagentIds: [], compactCount: 0, virtual: false, ...extra
  }
}
function codexSession(sessionId: string, primaryPath: string | null, extra: Partial<ReadoutSession> = {}): ReadoutSession {
  return {
    source: 'codex', sessionId, primaryPath, paths: primaryPath ? [primaryPath] : [],
    subagentPaths: [], subagentIds: [], compactCount: 0, virtual: false, ...extra
  }
}

function fakeProbe(pathEnv: string, build: (input: ResumeProbeInput) => { command: string } | { refused: string }): ResumeProbe {
  return { pathEnv, build }
}

/** Minimal Codex state db fixture (⑥ L3 C2c-3: `codexRecoverySide` reads `.available`/`.threads` only). */
function codexStateDb(threads: CodexThreadRow[]): CodexStateDb {
  return { available: true, version: 1, candidates: 1, threads, edges: [], audit: null }
}

describe('⑥ resume — data-layer buckets', () => {
  it('file and directory both present -> recoverable, pass', () => {
    const dir = tempDir()
    const main = file('a.jsonl')
    const sessions = [claudeSession('s1', main, { resumeCwd: dir })]
    const result = resumeCheck(ctx({ readout: readout(sessions) }))
    expect(result.bySource['claude-code'].swob.recoverable?.value).toBe(1)
    expect(result.bySource['claude-code'].swob.missingFile?.value).toBe(0)
    expect(result.bySource['claude-code'].swob.missingDirectory?.value).toBe(0)
    expect(result.bySource['claude-code'].verdict).toBe('pass')
    expect(result.verdict).toBe('pass')
  })

  it('primaryPath no longer on disk -> missing-file bucket, fail (data class)', () => {
    const gone = path.join(tempDir(), 'deleted.jsonl') // never written
    const sessions = [claudeSession('s2', gone)]
    const result = resumeCheck(ctx({ readout: readout(sessions) }))
    const entry = result.bySource['claude-code']
    expect(entry.swob.missingFile?.value).toBe(1)
    expect(entry.verdict).toBe('fail')
    const finding = result.findings.find((f) => f.code === 'resume.file-missing' && f.source === 'claude-code')
    expect(finding).toMatchObject({ verdict: 'fail' })
  })

  it('resumeCwd no longer on disk -> missing-directory bucket, warn (environment class, never fail alone)', () => {
    const main = file('b.jsonl')
    const goneDir = path.join(tempDir(), 'deleted-project')
    const sessions = [claudeSession('s3', main, { resumeCwd: goneDir })]
    const result = resumeCheck(ctx({ readout: readout(sessions) }))
    const entry = result.bySource['claude-code']
    expect(entry.swob.missingDirectory?.value).toBe(1)
    expect(entry.verdict).toBe('warn')
    expect(result.verdict).toBe('warn')
    const finding = result.findings.find((f) => f.code === 'resume.directory-missing')
    expect(finding).toMatchObject({ verdict: 'warn', source: 'claude-code' })
  })

  it('canResumeLocal:false -> unsupported bucket, excluded from the denominator entirely', () => {
    const sessions = [claudeSession('s4', null, { canResumeLocal: false, resumeUnavailableReason: 'ssh-only' })]
    const result = resumeCheck(ctx({ readout: readout(sessions) }))
    const entry = result.bySource['claude-code']
    expect(entry.swob.unsupportedSource?.value).toBe(1)
    expect(entry.swob.missingFile?.value).toBe(0)
    expect(entry.verdict).toBe('pass') // no findings at all: the one session is entirely excluded
  })

  it('a virtual (intra-file branch) session is never graded at all', () => {
    const main = file('virtual.jsonl')
    const sessions = [claudeSession('s5', main, { virtual: true, resumeCwd: '/definitely/not/here' })]
    const result = resumeCheck(ctx({ readout: readout(sessions) }))
    expect(result.bySource['claude-code'].oracle.sessions?.value).toBe(0)
    expect(result.bySource['claude-code'].verdict).toBe('pass')
  })
})

describe('⑥ resume — L3 anchor comparison (C2c-3: 恢复侧 vs 展示侧, [D] non-independent)', () => {
  it('a single-file session degenerates to comparing a file against itself -> always match (documented, not special-cased)', () => {
    // session.paths has only one member, so 恢复侧 (primaryPath) and 展示侧 (the freshest-anchor member of
    // session.paths) are structurally the same physical file here — this is the overwhelming majority
    // shape on a real machine (C2c 独立验收: 58/59 Claude, 526/528 Codex) and is only ever an existence
    // check ("does this file still read cleanly"), never an independent-content check, for them.
    const main = file('c.jsonl')
    const sessions = [claudeSession('s6', main)]
    const claudeParsed = new Map([[main, { records: 4, elapsedMs: 1, partial: false, resumeAnchors: { lastUser: 'aaaaaaaa', lastAssistant: 'bbbbbbbb', lastTimestamp: '2026-08-01T00:00:00.000Z' } }]])
    const result = resumeCheck(ctx({ readout: readout(sessions, { claudeParsed }) }))
    expect(result.bySource['claude-code'].swob.anchorMatch?.value).toBe(1)
    expect(result.bySource['claude-code'].swob.anchorMismatch?.value).toBe(0)
    expect(result.bySource['claude-code'].verdict).toBe('pass')
  })

  it('Claude continuation pair: 展示侧 (the newer shard) differs from 恢复侧 (primaryPath) -> anchor mismatch, fail (F1o real-HOME shape)', () => {
    const primary = file('main.jsonl') // 恢复侧: session.primaryPath, the sessionId-named file `claude --resume` opens
    const shard = file('shard.jsonl') // 展示侧 wins this one: its own anchor is the freshest in session.paths
    const sessions = [claudeSession('s7', primary, {
      paths: [primary, shard],
      updatedAt: '2026-08-08T00:00:00.000Z' // >= shard's own timestamp, so this is not mistaken for cache-lag
    })]
    const claudeParsed = new Map([
      [primary, { records: 2, elapsedMs: 1, partial: false, resumeAnchors: { lastUser: 'aaaaaaaa', lastAssistant: 'bbbbbbbb', lastTimestamp: '2026-07-01T00:00:00.000Z' } }],
      [shard, { records: 2, elapsedMs: 1, partial: false, resumeAnchors: { lastUser: 'cccccccc', lastAssistant: 'dddddddd', lastTimestamp: '2026-08-08T00:00:00.000Z' } }]
    ])
    const result = resumeCheck(ctx({ readout: readout(sessions, { claudeParsed }) }))
    const entry = result.bySource['claude-code']
    expect(entry.swob.anchorMismatch?.value).toBe(1)
    expect(entry.verdict).toBe('fail')
    expect(result.findings.find((f) => f.code === 'resume.anchor-mismatch')).toMatchObject({ verdict: 'fail', source: 'claude-code' })
  })

  it('Codex state db points at a secondary rollout Swob did not pick as primary -> 恢复侧 ≠ 展示侧, anchor mismatch, fail', () => {
    const primary = file('codex-primary.jsonl') // Swob's own pick (not the db pointer) — wins 展示侧: freshest anchor
    const secondary = file('codex-secondary.jsonl') // state db's rollout_path — 恢复侧: what `codex resume` actually opens
    const sessions = [codexSession('s-db-secondary', primary, {
      paths: [primary, secondary],
      updatedAt: '2026-09-13T04:50:00.000Z' // >= primary's (展示侧's) own timestamp: not cache-lag
    })]
    const codexParsed = new Map<string, CodexParseResult>([
      [primary, { records: 4, elapsedMs: 1, resumeAnchors: { lastUser: 'aaaaaaaa', lastAssistant: 'bbbbbbbb', lastTimestamp: '2026-09-13T04:43:37.000Z' } }],
      [secondary, { records: 10, elapsedMs: 1, resumeAnchors: { lastUser: 'cccccccc', lastAssistant: 'dddddddd', lastTimestamp: '2026-09-13T04:41:00.000Z' } }]
    ])
    const db = codexStateDb([{ id: 's-db-secondary', rolloutPath: secondary, threadSource: null, archived: false }])
    const result = resumeCheck(ctx({ readout: readout(sessions, { codexParsed }), codexDb: db }))
    const entry = result.bySource.codex
    expect(entry.swob.anchorMismatch?.value).toBe(1)
    expect(entry.verdict).toBe('fail')
    expect(result.findings.find((f) => f.code === 'resume.anchor-mismatch')).toMatchObject({ verdict: 'fail', source: 'codex' })
  })

  it('Codex state db points at the file Swob already shows (the post-F1p shape) -> match, pass', () => {
    // F1p (once landed) makes Swob's own primaryPath follow the state db pointer; this fixture simulates
    // that outcome directly (task book: "夹具里模拟「Swob 主文件 == db 指针」的情形 → match") without
    // depending on F1p's own landing.
    const rollout = file('codex-current.jsonl')
    const sessions = [codexSession('s-db-matches-primary', rollout)]
    const codexParsed = new Map<string, CodexParseResult>([
      [rollout, { records: 4, elapsedMs: 1, resumeAnchors: { lastUser: 'aaaaaaaa', lastAssistant: 'bbbbbbbb', lastTimestamp: '2026-09-13T04:46:20.000Z' } }]
    ])
    const db = codexStateDb([{ id: 's-db-matches-primary', rolloutPath: rollout, threadSource: null, archived: false }])
    const result = resumeCheck(ctx({ readout: readout(sessions, { codexParsed }), codexDb: db }))
    const entry = result.bySource.codex
    expect(entry.swob.anchorMatch?.value).toBe(1)
    expect(entry.swob.anchorMismatch?.value).toBe(0)
    expect(entry.verdict).toBe('pass')
  })

  it('db has no row for this session -> falls back to primaryPath (same as Claude), not an automatic failure', () => {
    const main = file('codex-no-db-row.jsonl')
    const sessions = [codexSession('s-no-db-row', main)]
    const codexParsed = new Map<string, CodexParseResult>([
      [main, { records: 4, elapsedMs: 1, resumeAnchors: { lastUser: 'aaaaaaaa', lastAssistant: 'bbbbbbbb', lastTimestamp: '2026-09-01T00:00:00.000Z' } }]
    ])
    const db = codexStateDb([]) // db available, but no row at all for this session id
    const result = resumeCheck(ctx({ readout: readout(sessions, { codexParsed }), codexDb: db }))
    const entry = result.bySource.codex
    expect(entry.swob.anchorMatch?.value).toBe(1)
    expect(entry.swob.anchorCannotVerify?.value).toBe(0)
    expect(entry.verdict).toBe('pass')
  })

  it('mismatch downgrades to "注意 · 缓存滞后" when Swob\'s own updatedAt has not caught up to the fresher anchor (task book S2)', () => {
    const primary = file('lag-main.jsonl')
    const shard = file('lag-shard.jsonl')
    const sessions = [claudeSession('s-cache-lag', primary, {
      paths: [primary, shard],
      updatedAt: '2026-07-01T00:00:00.000Z' // Swob's own summary thinks this is the latest activity...
    })]
    const claudeParsed = new Map([
      [primary, { records: 2, elapsedMs: 1, partial: false, resumeAnchors: { lastUser: 'aaaaaaaa', lastAssistant: 'bbbbbbbb', lastTimestamp: '2026-07-01T00:00:00.000Z' } }],
      // ...but this run's own fresh re-read of the shard already sees content dated after that.
      [shard, { records: 2, elapsedMs: 1, partial: false, resumeAnchors: { lastUser: 'cccccccc', lastAssistant: 'dddddddd', lastTimestamp: '2026-07-15T00:00:00.000Z' } }]
    ])
    const result = resumeCheck(ctx({ readout: readout(sessions, { claudeParsed }) }))
    const entry = result.bySource['claude-code']
    expect(entry.swob.anchorCacheLag?.value).toBe(1)
    expect(entry.swob.anchorMismatch?.value).toBe(0)
    expect(entry.verdict).toBe('warn') // a note, not a fail: task book — this is more likely stale bookkeeping than a real divergence
    expect(result.findings.find((f) => f.code === 'resume.anchor-cache-lag')).toMatchObject({ verdict: 'warn', source: 'claude-code' })
  })

  it('Codex db has a row but this run never read the file it points to -> "注意 · 无法核对" (task book S3), not silently matched or failed', () => {
    const main = file('unverifiable-primary.jsonl')
    const neverRead = path.join(tempDir(), 'unverifiable-secondary.jsonl') // deliberately never written/read this run
    const sessions = [codexSession('s-cannot-verify', main)]
    const codexParsed = new Map<string, CodexParseResult>([
      [main, { records: 4, elapsedMs: 1, resumeAnchors: { lastUser: 'aaaaaaaa', lastAssistant: 'bbbbbbbb', lastTimestamp: '2026-09-01T00:00:00.000Z' } }]
    ])
    const db = codexStateDb([{ id: 's-cannot-verify', rolloutPath: neverRead, threadSource: null, archived: false }])
    const result = resumeCheck(ctx({ readout: readout(sessions, { codexParsed }), codexDb: db }))
    const entry = result.bySource.codex
    expect(entry.swob.anchorCannotVerify?.value).toBe(1)
    expect(entry.swob.anchorMatch?.value).toBe(0)
    expect(entry.swob.anchorMismatch?.value).toBe(0)
    expect(entry.verdict).toBe('warn')
    expect(result.findings.find((f) => f.code === 'resume.anchor-cannot-verify')).toMatchObject({ verdict: 'warn', source: 'codex' })
  })

  it('a Codex file whose read genuinely threw (records: null) -> would-404, folded into resume.file-missing (fail)', () => {
    const rollout = file('rollout.jsonl')
    const sessions = [codexSession('s9', rollout)]
    const codexParsed = new Map<string, CodexParseResult>([[rollout, { records: null, elapsedMs: 1 }]])
    const result = resumeCheck(ctx({ readout: readout(sessions, { codexParsed }) }))
    const entry = result.bySource.codex
    expect(entry.verdict).toBe('fail')
    expect(result.findings.some((f) => f.code === 'resume.file-missing' && f.source === 'codex')).toBe(true)
  })

  it('no resumeAnchors recorded at all (e.g. an older readout) -> excluded from the tally, not a failure', () => {
    const main = file('d.jsonl')
    const sessions = [claudeSession('s10', main)]
    const claudeParsed = new Map([[main, { records: 2, elapsedMs: 1, partial: false }]]) // no resumeAnchors key
    const result = resumeCheck(ctx({ readout: readout(sessions, { claudeParsed }) }))
    const entry = result.bySource['claude-code']
    expect(entry.swob.anchorCompared?.value).toBe(0)
    expect(entry.verdict).toBe('pass')
  })

  it('an empty session (both anchors null) -> skipped, still counts as a pass, not a mismatch', () => {
    const main = file('empty.jsonl')
    const sessions = [claudeSession('s11', main)]
    const claudeParsed = new Map([[main, { records: 0, elapsedMs: 1, partial: false, resumeAnchors: { lastUser: null, lastAssistant: null, lastTimestamp: null } }]])
    const result = resumeCheck(ctx({ readout: readout(sessions, { claudeParsed }) }))
    expect(result.bySource['claude-code'].swob.anchorMatch?.value).toBe(1)
    expect(result.bySource['claude-code'].swob.anchorMismatch?.value).toBe(0)
  })
})

describe('⑥ resume — command layer (sampled; program lookup + zsh syntax check)', () => {
  it('program found and command syntactically valid -> found, pass', () => {
    const main = file('e.jsonl')
    const dir = tempDir()
    const bin = tempDir()
    fs.writeFileSync(path.join(bin, 'claude'), '#!/bin/sh\n')
    fs.chmodSync(path.join(bin, 'claude'), 0o755)
    const sessions = [claudeSession('s12', main, { resumeCwd: dir })]
    const probe = fakeProbe(bin, () => ({ command: 'echo resume' }))
    const result = resumeCheck(ctx({ readout: readout(sessions), resumeProbe: probe }))
    const entry = result.bySource['claude-code']
    expect(entry.swob.commandSampled?.value).toBe(1)
    expect(entry.swob.commandFound?.value).toBe(1)
    expect(entry.verdict).toBe('pass')
  })

  it('program missing from PATH -> warn (environment class)', () => {
    const main = file('f.jsonl')
    const sessions = [claudeSession('s13', main)]
    const emptyBin = tempDir()
    const probe = fakeProbe(emptyBin, () => ({ command: 'echo resume' }))
    const result = resumeCheck(ctx({ readout: readout(sessions), resumeProbe: probe }))
    const entry = result.bySource['claude-code']
    expect(entry.swob.commandMissing?.value).toBe(1)
    expect(entry.verdict).toBe('warn')
    expect(result.findings.find((f) => f.code === 'resume.program-not-found')).toMatchObject({ verdict: 'warn' })
  })

  it('program is a broken symlink -> warn, says broken-symlink not just missing', () => {
    const main = file('g.jsonl')
    const binDir = tempDir()
    fs.symlinkSync(path.join(binDir, 'nonexistent-target'), path.join(binDir, 'claude'))
    const sessions = [claudeSession('s14', main)]
    const probe = fakeProbe(binDir, () => ({ command: 'echo resume' }))
    const result = resumeCheck(ctx({ readout: readout(sessions), resumeProbe: probe }))
    const entry = result.bySource['claude-code']
    expect(entry.swob.commandBrokenSymlink?.value).toBe(1)
    expect(entry.swob.commandMissing?.value).toBe(0)
    expect(result.findings.find((f) => f.code === 'resume.program-broken-symlink')).toMatchObject({ verdict: 'warn' })
  })

  it('zsh rejects the command syntax -> fail (data class: Swob\'s own bug, not the environment)', () => {
    const main = file('h.jsonl')
    const sessions = [claudeSession('s15', main)]
    // Deliberately unbalanced quote: a real login shell would refuse to even parse this.
    const probe = fakeProbe('/usr/bin:/bin', () => ({ command: 'echo "unterminated' }))
    const result = resumeCheck(ctx({ readout: readout(sessions), resumeProbe: probe }))
    const entry = result.bySource['claude-code']
    expect(entry.swob.commandSyntaxInvalid?.value).toBe(1)
    expect(entry.verdict).toBe('fail')
    expect(result.findings.find((f) => f.code === 'resume.command-syntax-invalid')).toMatchObject({ verdict: 'fail' })
  })

  it('no resumeProbe injected (e.g. the AI diary) -> command layer unavailable, never grades the source', () => {
    const main = file('i.jsonl')
    const sessions = [claudeSession('s16', main)]
    const result = resumeCheck(ctx({ readout: readout(sessions), resumeProbe: null }))
    const entry = result.bySource['claude-code']
    expect(entry.swob.commandSampled?.value).toBeNull()
    expect(entry.swob.commandSampled?.reason).toBe('resume.probe-not-injected')
    expect(entry.verdict).toBe('pass') // data layer clean; command layer simply does not participate
  })
})

describe('⑥ resume — sampling (task book H1/H2)', () => {
  it('the seeded sample is reproducible: same seed + same sessions -> identical set of probed sessions', () => {
    const sessions = Array.from({ length: 20 }, (_, index) => claudeSession(`seed-${index}`, file(`seed-${index}.jsonl`)))
    const probed: string[][] = []
    for (let run = 0; run < 2; run++) {
      const seen: string[] = []
      const probe = fakeProbe('/usr/bin:/bin', (input) => { seen.push(input.sessionId); return { command: 'echo x' } })
      resumeCheck(ctx({ readout: readout(sessions), resumeProbe: probe, resumeSample: { perSource: 4, seed: '2026-09-28' } }))
      probed.push([...seen].sort())
    }
    expect(probed[0]).toEqual(probed[1])
    expect(probed[0].length).toBe(4)
  })

  it('resumeSampling (C2c-3 report appendix) reports salted, reproducible ids for the sessions actually sampled this run', () => {
    const sessions = Array.from({ length: 20 }, (_, index) => claudeSession(`disclose-${index}`, file(`disclose-${index}.jsonl`)))
    const probe = fakeProbe('/usr/bin:/bin', () => ({ command: 'echo x' }))
    const first = resumeCheck(ctx({ readout: readout(sessions), resumeProbe: probe, resumeSample: { perSource: 4, seed: '2026-09-28' } }))
    const second = resumeCheck(ctx({ readout: readout(sessions), resumeProbe: probe, resumeSample: { perSource: 4, seed: '2026-09-28' } }))
    expect(first.resumeSampling?.sampledIds.length).toBeGreaterThan(0)
    expect(first.resumeSampling?.sampledIds.every((id) => /^[0-9a-f]{8}$/.test(id))).toBe(true)
    // Same seed + same session set -> the same salted id list, both runs (task book H1: "同一天两次运行抽样相同").
    expect(second.resumeSampling?.sampledIds).toEqual(first.resumeSampling?.sampledIds)
    expect(first.resumeSampling?.localDate).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(Number.isInteger(first.resumeSampling?.timezoneOffsetMinutes)).toBe(true)
  })

  it('resumeSampling is still present (seed/local day disclosed) when no command-layer probe is injected', () => {
    // Sampling itself (which sessions the seed picks) does not depend on a probe being injected — only
    // *acting* on the sample does — so the choice is still made and still disclosed.
    const sessions = [claudeSession('lone', file('lone.jsonl'))]
    const result = resumeCheck(ctx({ readout: readout(sessions), resumeProbe: null }))
    expect(result.resumeSampling?.sampledIds.length).toBe(1)
    expect(result.resumeSampling?.localDate).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('resumeSampling.sampledIds is empty when there is nothing to sample at all', () => {
    const result = resumeCheck(ctx({ readout: readout([]) }))
    expect(result.resumeSampling?.sampledIds).toEqual([])
  })

  it('a different seed (a different day) can pick a different sample', () => {
    const sessions = Array.from({ length: 20 }, (_, index) => claudeSession(`day-${index}`, file(`day-${index}.jsonl`)))
    const runWithSeed = (seed: string): string[] => {
      const seen: string[] = []
      const probe = fakeProbe('/usr/bin:/bin', (input) => { seen.push(input.sessionId); return { command: 'echo x' } })
      resumeCheck(ctx({ readout: readout(sessions), resumeProbe: probe, resumeSample: { perSource: 4, seed } }))
      return [...seen].sort()
    }
    const a = runWithSeed('2026-09-28')
    const b = runWithSeed('2099-01-01')
    expect(a).not.toEqual(b) // not guaranteed by definition, but true for this fixed fixture + these two seeds
  })

  it('a session active in the last 7 days is added to the sample even if the seeded pick misses it', () => {
    const now = Date.parse('2026-09-28T00:00:00.000Z')
    vi.setSystemTime(now)
    const sessions = [
      ...Array.from({ length: 4 }, (_, index) => claudeSession(`filler-${index}`, file(`filler-${index}.jsonl`))),
      claudeSession('most-active', file('most-active.jsonl'), { messageCount: 999, updatedAt: new Date(now - 60_000).toISOString() })
    ]
    const seen: string[] = []
    const probe = fakeProbe('/usr/bin:/bin', (input) => { seen.push(input.sessionId); return { command: 'echo x' } })
    resumeCheck(ctx({ readout: readout(sessions), resumeProbe: probe, resumeSample: { perSource: 4, seed: 'irrelevant-seed-that-would-not-pick-it' } }))
    expect(seen).toContain('most-active')
    vi.useRealTimers()
  })

  it('a session last active more than 7 days ago is not added by the "most active" top-up', () => {
    const now = Date.parse('2026-09-28T00:00:00.000Z')
    vi.setSystemTime(now)
    const eightDaysAgo = new Date(now - 8 * 24 * 60 * 60 * 1000).toISOString()
    const sessions = [
      ...Array.from({ length: 4 }, (_, index) => claudeSession(`filler2-${index}`, file(`filler2-${index}.jsonl`))),
      claudeSession('stale-but-busy', file('stale.jsonl'), { messageCount: 999, updatedAt: eightDaysAgo })
    ]
    const seen: string[] = []
    const probe = fakeProbe('/usr/bin:/bin', (input) => { seen.push(input.sessionId); return { command: 'echo x' } })
    resumeCheck(ctx({ readout: readout(sessions), resumeProbe: probe, resumeSample: { perSource: 4, seed: 'irrelevant-seed-that-would-not-pick-it' } }))
    expect(seen).not.toContain('stale-but-busy')
    vi.useRealTimers()
  })
})

describe('⑥ resume — Cursor / capability-table sources', () => {
  it('Cursor is forced not-applicable when it has data (this check\'s infrastructure is Claude/Codex-only)', () => {
    const result = resumeCheck(ctx({
      readout: readout([]),
      presence: [{ source: 'cursor', roots: [], present: true }]
    }))
    expect(result.bySource.cursor).toMatchObject({ verdict: 'not-applicable' })
  })

  it('Cursor with no data on this machine keeps the generic source.no-data reason, not source.capability-unavailable', () => {
    const result = resumeCheck(ctx({ readout: readout([]), presence: [{ source: 'cursor', roots: [], present: false }] }))
    expect(result.bySource.cursor).toMatchObject({ verdict: 'not-applicable' })
    expect(result.bySource.cursor.swob.status?.reason).toBe('source.no-data')
  })
})

describe('⑥ resume — readout not isolated', () => {
  it('an undetermined readout leaves the check undetermined, never misreported as fail', () => {
    const result = resumeCheck(ctx({ readout: readout([], { status: 'undetermined', reason: 'readout.not-isolated' }) }))
    expect(result.bySource['claude-code'].verdict).toBe('undetermined')
    expect(result.verdict).toBe('undetermined')
    expect(result.reason).toBe('readout.not-isolated')
  })
})

describe('locateProgram (command layer program lookup)', () => {
  it('found / broken-symlink / missing, distinguished (replaces resume-audit.ts#isBinaryAvailable which cannot say why)', () => {
    const bin = tempDir()
    fs.symlinkSync(path.join(bin, 'gone'), path.join(bin, 'broken'))
    fs.writeFileSync(path.join(bin, 'ok'), '#!/bin/sh\n')
    fs.chmodSync(path.join(bin, 'ok'), 0o755)
    expect(locateProgram('ok', bin)).toBe('found')
    expect(locateProgram('broken', bin)).toBe('broken-symlink')
    expect(locateProgram('nope', bin)).toBe('missing')
  })
})
