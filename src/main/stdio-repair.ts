/**
 * GUI-launched (LaunchServices / `open`) Electron apps on macOS can start with
 * stdio fds 0-2 in a defunct state: fstat still succeeds, but writes fail with
 * EPIPE (console.error → uncaught-exception dialog loops) and child_process
 * spawns fail with EBADF (Keychain reads, terminal detection, agent engine).
 *
 * Probing is unreliable — a defunct fd looks alive. So for packaged, non-TTY
 * launches we unconditionally rebind fds 0-2 to /dev/null: closeSync(fd) then
 * openSync('/dev/null') reclaims the exact same fd number (lowest free).
 *
 * This module must be imported FIRST in the main entry, before anything that
 * writes to stdio or spawns children.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

function describeFd(fd: number): string {
  try {
    const stat = fs.fstatSync(fd)
    if (stat.isSocket()) return 'socket'
    if (stat.isFIFO()) return 'fifo'
    if (stat.isCharacterDevice()) return 'chardev'
    return 'other'
  } catch (error) {
    return `stat-failed:${(error as NodeJS.ErrnoException).code}`
  }
}

export function repairStdio(): void {
  const isPackaged = !process.defaultApp && !process.env['ELECTRON_RENDERER_URL']
  const hasTty = Boolean(process.stdout.isTTY || process.stderr.isTTY)
  if (!isPackaged || hasTty) return

  const before = [0, 1, 2].map((fd) => `${fd}:${describeFd(fd)}`).join(' ')
  const rebound: number[] = []
  for (const fd of [0, 1, 2]) {
    try {
      try { fs.closeSync(fd) } catch { /* already closed */ }
      const opened = fs.openSync('/dev/null', fd === 0 ? 'r' : 'w')
      if (opened === fd) {
        rebound.push(fd)
      } else {
        // Something else grabbed the slot — extremely unexpected this early.
        fs.closeSync(opened)
      }
    } catch { /* leave as-is */ }
  }

  try {
    const logDir = path.join(os.homedir(), '.claude-session-manager')
    fs.mkdirSync(logDir, { recursive: true })
    fs.appendFileSync(
      path.join(logDir, 'stdio-repair.log'),
      `${new Date().toISOString()} pid=${process.pid} before=[${before}] rebound=[${rebound.join(',')}]\n`
    )
  } catch { /* diagnostics only */ }
}

repairStdio()

function logLine(text: string): void {
  try {
    fs.appendFileSync(
      path.join(os.homedir(), '.claude-session-manager', 'stdio-repair.log'),
      `${new Date().toISOString()} pid=${process.pid} ${text}\n`
    )
  } catch { /* diagnostics only */ }
}

/**
 * Post-repair self-tests: prove each spawn shape works in this launch context.
 * Variant B replicates the exact Keychain call shape (async spawn, stdio all
 * pipes, stdin.end()) that reportedly fails with a raw synchronous EBADF.
 */
export function logSpawnSelfTest(): void {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const cp = require('node:child_process') as typeof import('node:child_process')

  try {
    const result = cp.spawnSync('/bin/echo', ['ok'], { encoding: 'utf-8', timeout: 3000 })
    logLine(`selftest-sync=${result.error ? `error:${String(result.error)}` : `ok:${result.status}`}`)
  } catch (error) {
    logLine(`selftest-sync=threw:${String(error)}`)
  }

  const variants: Array<[string, ('pipe' | 'ignore')[]]> = [
    ['security-pipes', ['pipe', 'pipe', 'pipe']],
    ['security-ignore-stdin', ['ignore', 'pipe', 'pipe']]
  ]
  for (const [name, stdio] of variants) {
    try {
      const child = cp.spawn('/usr/bin/security', [
        'find-generic-password', '-a', 'swob-selftest', '-s', 'swob-selftest', '-w'
      ], { stdio: stdio as ('pipe' | 'ignore')[] })
      child.on('error', (error) => logLine(`selftest-${name}=error-event:${String(error)}`))
      child.on('close', (code) => logLine(`selftest-${name}=closed:${code}`))
      if (stdio[0] === 'pipe') child.stdin?.end()
    } catch (error) {
      logLine(`selftest-${name}=threw-sync:${String(error)}`)
    }
  }
}
