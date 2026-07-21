import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  buildCliWrapperScript,
  getCliTargetCandidates,
  installSwobCli,
  SWOB_APP_CLI_PATH
} from './cli-install'

function expectedShellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`
}

describe('CLI install helper', () => {
  let tmpRoot: string

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-cli-install-'))
  })

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  })

  it('generates a wrapper pinned to the app bundle CLI, with NODE_PATH reaching unpacked native deps', () => {
    const script = buildCliWrapperScript()
    expect(script).toContain(`exec node "${SWOB_APP_CLI_PATH}" "$@"`)
    // grep/FTS 依赖 better-sqlite3(原生模块),只存在于 app.asar.unpacked 内;
    // 系统 node 必须经 NODE_PATH 才能解析到它(2026-07-22 CLI 全挂回归)。
    expect(script).toContain(
      'NODE_PATH="/Applications/Swob.app/Contents/Resources/app.asar.unpacked/node_modules'
    )
  })

  it('keeps /usr/local/bin first, then PATH fallbacks in priority order', () => {
    const homeDir = path.join(tmpRoot, 'home')
    const homebrewDir = path.join(tmpRoot, 'homebrew', 'bin')
    const localDir = path.join(homeDir, '.local', 'bin')
    const candidates = getCliTargetCandidates({
      homeDir,
      pathEnv: [localDir, homebrewDir].join(path.delimiter),
      primaryTargetDir: path.join(tmpRoot, 'usr-local-bin'),
      homebrewTargetDir: homebrewDir,
      localTargetDir: localDir
    })

    expect(candidates.map((candidate) => candidate.kind)).toEqual(['primary', 'homebrew', 'local'])
  })

  it('skips fallback directories that are not on PATH', () => {
    const homeDir = path.join(tmpRoot, 'home')
    const homebrewDir = path.join(tmpRoot, 'homebrew', 'bin')
    const localDir = path.join(homeDir, '.local', 'bin')
    const candidates = getCliTargetCandidates({
      homeDir,
      pathEnv: '',
      primaryTargetDir: path.join(tmpRoot, 'usr-local-bin'),
      homebrewTargetDir: homebrewDir,
      localTargetDir: localDir
    })

    expect(candidates.map((candidate) => candidate.kind)).toEqual(['primary'])
  })

  it('falls back to ~/.local/bin when it is on PATH and the primary target is unavailable', () => {
    const homeDir = path.join(tmpRoot, 'home')
    const localDir = path.join(homeDir, '.local', 'bin')
    const primaryTargetDir = path.join(tmpRoot, 'missing', 'usr-local-bin')

    const result = installSwobCli({
      homeDir,
      pathEnv: localDir,
      primaryTargetDir,
      homebrewTargetDir: path.join(tmpRoot, 'homebrew', 'bin'),
      localTargetDir: localDir
    })

    expect(result.cliInstalled).toBe(true)
    expect(result.cliPath).toBe(path.join(localDir, 'swob'))
    expect(result.fallbackUsed).toBe(true)
    expect(fs.readFileSync(result.wrapperPath, 'utf-8')).toBe(buildCliWrapperScript())
    expect(fs.readlinkSync(result.cliPath!)).toBe(result.wrapperPath)
  })

  it('repairs the wrapper without replacing an existing symlink to it', () => {
    const homeDir = path.join(tmpRoot, 'home')
    const primaryTargetDir = path.join(tmpRoot, 'usr-local-bin')
    const wrapperPath = path.join(homeDir, '.claude-session-manager', 'swob-cli.sh')
    fs.mkdirSync(primaryTargetDir, { recursive: true })
    fs.symlinkSync(wrapperPath, path.join(primaryTargetDir, 'swob'))

    const result = installSwobCli({
      homeDir,
      pathEnv: '',
      primaryTargetDir
    })

    expect(result.cliInstalled).toBe(true)
    expect(result.cliPath).toBe(path.join(primaryTargetDir, 'swob'))
    expect(result.fallbackUsed).toBe(false)
    expect(fs.readFileSync(wrapperPath, 'utf-8')).toBe(buildCliWrapperScript())
  })

  it('quotes shell metacharacters in the manual sudo command', () => {
    const homeDir = path.join(tmpRoot, 'home dir \' " $(touch bad) `touch bad`')
    const primaryTargetDir = path.join(tmpRoot, 'target dir \' " $(touch bad) `touch bad`')
    const wrapperPath = path.join(homeDir, '.claude-session-manager', 'swob-cli.sh')
    const manualTarget = path.join(primaryTargetDir, 'swob')

    const result = installSwobCli({
      homeDir,
      pathEnv: '',
      primaryTargetDir
    })

    expect(result.cliInstalled).toBe(false)
    expect(result.cliManualInstall).toBe(
      `sudo ln -sf ${expectedShellQuote(wrapperPath)} ${expectedShellQuote(manualTarget)}`
    )
  })
})
