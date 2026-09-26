import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

/**
 * A scripted stand-in for the `sqlite3` CLI, installed by prepending its
 * directory to PATH. The loaders spawn the bare command name without an `env`
 * option, so PATH decides which binary runs. POSIX `sh` only: callers skip on
 * win32, where the SQLite-backed sources are unsupported anyway.
 */
export type FakeSqlite3Behavior =
  /** `exec sleep 30`: a hung process that `child.kill()` terminates directly. */
  | { kind: 'hang' }
  /**
   * Print `stderr` and exit non-zero. With `failures`, only the first N
   * invocations fail (claimed atomically, safe for concurrent probes) and
   * later ones run the real sqlite3.
   */
  | { kind: 'fail'; stderr: string; exitCode?: number; failures?: number }
  /** Print `stdout` and exit with `exitCode` (default 0). */
  | { kind: 'stdout'; stdout: string; exitCode?: number }
  /** Fail only when the SQL on stdin contains every fragment in order; otherwise run the real sqlite3. */
  | { kind: 'fail-matching'; match: readonly string[]; stderr: string; exitCode?: number }
  /** PATH points at an empty directory, so spawning `sqlite3` fails with ENOENT. */
  | { kind: 'missing' }

export interface FakeSqlite3 {
  readonly binDir: string
  /** How many times the fake was invoked since it was installed. */
  invocations(): number
  /** Restore PATH and remove the fake. Safe to call twice. */
  restore(): void
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function isExecutable(candidate: string): boolean {
  try {
    fs.accessSync(candidate, fs.constants.X_OK)
    return fs.statSync(candidate).isFile()
  } catch {
    return false
  }
}

/** Absolute path of the real sqlite3 on the current PATH, or null. */
export function realSqlite3Path(searchPath = process.env.PATH ?? ''): string | null {
  for (const directory of searchPath.split(path.delimiter)) {
    if (!directory) continue
    const candidate = path.join(directory, 'sqlite3')
    if (isExecutable(candidate)) return candidate
  }
  return null
}

function scriptBody(behavior: Exclude<FakeSqlite3Behavior, { kind: 'missing' }>, real: string, stateDir: string): string {
  const failWith = (stderr: string, exitCode = 1) => [
    `printf '%s\\n' ${shellQuote(stderr)} >&2`,
    `exit ${exitCode}`
  ]
  switch (behavior.kind) {
    case 'hang':
      return 'exec sleep 30'
    case 'stdout':
      return [
        'cat > /dev/null',
        `printf '%s\\n' ${shellQuote(behavior.stdout)}`,
        `exit ${behavior.exitCode ?? 0}`
      ].join('\n')
    case 'fail': {
      if (behavior.failures === undefined) {
        return ['cat > /dev/null', ...failWith(behavior.stderr, behavior.exitCode)].join('\n')
      }
      // mkdir is atomic: exactly `failures` concurrent invocations claim a slot.
      const claims = Array.from({ length: behavior.failures }, (_, index) =>
        `mkdir ${shellQuote(path.join(stateDir, `failure-${index + 1}`))} 2>/dev/null`
      ).join(' || ')
      return [
        `if ${claims}; then`,
        '  cat > /dev/null',
        ...failWith(behavior.stderr, behavior.exitCode).map((line) => `  ${line}`),
        'fi',
        `exec ${shellQuote(real)} "$@"`
      ].join('\n')
    }
    case 'fail-matching': {
      const pattern = `*${behavior.match.map(shellQuote).join('*')}*`
      return [
        'sql=$(cat)',
        'case "$sql" in',
        `  ${pattern})`,
        ...failWith(behavior.stderr, behavior.exitCode).map((line) => `    ${line}`),
        '    ;;',
        'esac',
        `printf '%s\\n' "$sql" | ${shellQuote(real)} "$@"`
      ].join('\n')
    }
  }
}

/** Install a fake `sqlite3` first on PATH. Always call `restore()` (for example in `afterEach`). */
export function installFakeSqlite3(behavior: FakeSqlite3Behavior): FakeSqlite3 {
  const originalPath = process.env.PATH
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-fake-sqlite3-'))
  const binDir = path.join(root, 'bin')
  const stateDir = path.join(root, 'state')
  const logPath = path.join(root, 'invocations.log')
  fs.mkdirSync(binDir)
  fs.mkdirSync(stateDir)
  fs.writeFileSync(logPath, '')

  if (behavior.kind === 'missing') {
    process.env.PATH = binDir
  } else {
    const real = realSqlite3Path(originalPath)
    if (!real) throw new Error('fake-sqlite3 needs a real sqlite3 on PATH')
    const script = [
      '#!/bin/sh',
      `printf 'x\\n' >> ${shellQuote(logPath)}`,
      scriptBody(behavior, real, stateDir),
      ''
    ].join('\n')
    const fake = path.join(binDir, 'sqlite3')
    fs.writeFileSync(fake, script)
    fs.chmodSync(fake, 0o755)
    process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ''}`
  }

  let restored = false
  return {
    binDir,
    invocations: () => fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean).length,
    restore: () => {
      if (restored) return
      restored = true
      if (originalPath === undefined) delete process.env.PATH
      else process.env.PATH = originalPath
      fs.rmSync(root, { recursive: true, force: true })
    }
  }
}
