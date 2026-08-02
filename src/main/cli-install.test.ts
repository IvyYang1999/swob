import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  buildCliWrapperScript,
  cliInstallOptionsForEnvironment,
  getCliTargetCandidates,
  installSwobCli,
  findInstalledSwobCommandPath,
  shouldAutoInstallCli,
  SWOB_APP_CLI_PATH
} from './cli-install'

function successfulLoginShell(
  _shellPath: string,
  command: string,
  environment: NodeJS.ProcessEnv
): string {
  if (command.includes('printf')) return environment.PATH || ''
  return '1.3.0'
}

describe('CLI install helper', () => {
  let tmpRoot: string

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-cli-install-'))
  })

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  })

  it('disables startup installation for disposable test homes', () => {
    expect(shouldAutoInstallCli({})).toBe(true)
    expect(shouldAutoInstallCli({ SWOB_TEST_HOME: '/tmp/swob-test' })).toBe(false)
    expect(shouldAutoInstallCli({ NODE_ENV: 'test' })).toBe(false)
    expect(shouldAutoInstallCli({ NODE_ENV: 'development' })).toBe(false)
  })

  it('contains packaged-test install targets inside SWOB_TEST_HOME', () => {
    const homeDir = path.join(tmpRoot, 'home')
    const targetDir = path.join(homeDir, 'bin')
    expect(cliInstallOptionsForEnvironment(homeDir, {
      SWOB_TEST_HOME: homeDir,
      SWOB_TEST_CLI_TARGET_DIR: targetDir,
      SWOB_TEST_APP_CLI_PATH: path.join(tmpRoot, 'Swob.app', 'cli.js'),
      PATH: '/usr/bin'
    })).toMatchObject({
      homeDir,
      primaryTargetDir: targetDir,
      appCliPath: path.join(tmpRoot, 'Swob.app', 'cli.js')
    })
    expect(cliInstallOptionsForEnvironment(homeDir, {
      SWOB_TEST_HOME: homeDir
    })).toMatchObject({
      homeDir,
      primaryTargetDir: targetDir
    })
    expect(() => cliInstallOptionsForEnvironment(homeDir, {
      SWOB_TEST_HOME: homeDir,
      SWOB_TEST_CLI_TARGET_DIR: '/opt/homebrew/bin'
    })).toThrow('must stay inside SWOB_TEST_HOME')
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

  it('bootstraps deployment with the same unpacked native dependency path', () => {
    const deployScript = fs.readFileSync(path.resolve('scripts/deploy-local.sh'), 'utf8')
    expect(deployScript).toContain(
      'APP_NODE_MODULES="${INSTALL_DIR}/${APP_NAME}.app/Contents/Resources/app.asar.unpacked/node_modules"'
    )
    expect(deployScript).toContain(
      'NODE_PATH="${APP_NODE_MODULES}${NODE_PATH:+:$NODE_PATH}" node "$APP_CLI" install'
    )
  })

  it('prefers writable login-PATH targets independently of the GUI PATH', () => {
    const homeDir = path.join(tmpRoot, 'home')
    const homebrewDir = path.join(tmpRoot, 'homebrew', 'bin')
    const localDir = path.join(homeDir, '.local', 'bin')
    const primaryDir = path.join(tmpRoot, 'usr-local-bin')
    fs.mkdirSync(homebrewDir, { recursive: true })
    fs.mkdirSync(primaryDir, { recursive: true })
    const candidates = getCliTargetCandidates({
      homeDir,
      pathEnv: '',
      loginPathEnv: [homebrewDir, primaryDir, localDir].join(path.delimiter),
      primaryTargetDir: primaryDir,
      homebrewTargetDir: homebrewDir,
      localTargetDir: localDir
    })

    expect(candidates.map((candidate) => candidate.kind)).toEqual(['homebrew', 'primary', 'local'])
    expect(candidates.every((candidate) => candidate.inLoginPath)).toBe(true)
  })

  it('reports fallback directories that are not on the login PATH instead of hiding them', () => {
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

    expect(candidates).toHaveLength(3)
    expect(candidates.every((candidate) => candidate.inLoginPath === false)).toBe(true)
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
      localTargetDir: localDir,
      runLoginShell: successfulLoginShell
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
      loginPathEnv: primaryTargetDir,
      primaryTargetDir,
      runLoginShell: successfulLoginShell
    })

    expect(result.cliInstalled).toBe(true)
    expect(result.cliPath).toBe(path.join(primaryTargetDir, 'swob'))
    expect(result.fallbackUsed).toBe(false)
    expect(fs.readFileSync(wrapperPath, 'utf-8')).toBe(buildCliWrapperScript())
  })

  it('does not fall back to asking the user to create a sudo symlink', () => {
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
    expect(result.cliManualInstall).toBeNull()
    expect(result.error).toContain('No writable CLI directory')
    expect(fs.existsSync(wrapperPath)).toBe(true)
    expect(fs.existsSync(manualTarget)).toBe(false)
  })

  it('an explicit install can add ~/.local/bin to the login shell and verify end to end', () => {
    const homeDir = path.join(tmpRoot, 'home')
    const localDir = path.join(homeDir, '.local', 'bin')
    const result = installSwobCli({
      homeDir,
      pathEnv: '',
      primaryTargetDir: path.join(tmpRoot, 'missing-primary'),
      homebrewTargetDir: path.join(tmpRoot, 'missing-homebrew'),
      localTargetDir: localDir,
      loginShell: '/bin/zsh',
      allowShellRcUpdate: true,
      expectedVersion: '1.3.0',
      runLoginShell: successfulLoginShell
    })

    expect(result).toMatchObject({
      cliInstalled: true,
      cliPath: path.join(localDir, 'swob'),
      cliVerified: true,
      shellRcUpdated: true
    })
    expect(fs.readFileSync(path.join(homeDir, '.zprofile'), 'utf-8')).toContain(localDir)
  })

  it('runs the installed command through a real login shell and checks its version', () => {
    const homeDir = path.join(tmpRoot, 'home')
    const targetDir = path.join(homeDir, 'bin')
    const appCliPath = path.join(tmpRoot, 'fake-app-cli.js')
    fs.mkdirSync(targetDir, { recursive: true })
    fs.writeFileSync(
      appCliPath,
      "if (process.argv.includes('--version')) process.stdout.write('1.3.0\\n')\n",
      'utf-8'
    )
    const loginPathEnv = [targetDir, process.env.PATH || '/usr/bin:/bin'].join(path.delimiter)
    const result = installSwobCli({
      homeDir,
      appCliPath,
      loginPathEnv,
      loginShell: '/bin/zsh',
      expectedVersion: '1.3.0',
      primaryTargetDir: targetDir,
      homebrewTargetDir: path.join(tmpRoot, 'missing-homebrew'),
      localTargetDir: path.join(homeDir, '.local', 'bin')
    })

    expect(result).toMatchObject({
      cliInstalled: true,
      cliPath: path.join(targetDir, 'swob'),
      cliVerified: true
    })
  })

  it('ignores dangling commands and repairs them only inside the selected target', () => {
    const homeDir = path.join(tmpRoot, 'home')
    const homebrewDir = path.join(tmpRoot, 'homebrew', 'bin')
    fs.mkdirSync(homebrewDir, { recursive: true })
    fs.symlinkSync(path.join(tmpRoot, 'deleted-e2e-home', 'swob-cli.sh'), path.join(homebrewDir, 'swob'))
    const options = {
      homeDir,
      loginPathEnv: homebrewDir,
      primaryTargetDir: path.join(tmpRoot, 'missing-primary'),
      homebrewTargetDir: homebrewDir,
      localTargetDir: path.join(homeDir, '.local', 'bin'),
      runLoginShell: successfulLoginShell
    }

    expect(findInstalledSwobCommandPath(options)).toBeNull()
    const installed = installSwobCli(options)
    expect(installed.cliInstalled).toBe(true)
    expect(fs.readlinkSync(path.join(homebrewDir, 'swob'))).toBe(installed.wrapperPath)
  })

  it('SWOB_TEST_HOME installation leaves global command paths byte-for-byte unchanged', () => {
    const inspect = (filePath: string): string => {
      try {
        const stat = fs.lstatSync(filePath)
        return stat.isSymbolicLink()
          ? `symlink:${fs.readlinkSync(filePath)}`
          : `file:${stat.mode}:${stat.size}:${stat.mtimeMs}`
      } catch {
        return 'missing'
      }
    }
    const globalPaths = ['/usr/local/bin/swob', '/opt/homebrew/bin/swob']
    const before = globalPaths.map(inspect)
    const testHome = path.join(tmpRoot, 'isolated-home')
    fs.mkdirSync(path.join(testHome, 'bin'), { recursive: true })
    const isolated = cliInstallOptionsForEnvironment(testHome, {
      SWOB_TEST_HOME: testHome,
      SWOB_TEST_APP_CLI_PATH: path.join(tmpRoot, 'Swob.app', 'cli.js'),
      PATH: '/usr/bin'
    })
    const result = installSwobCli({
      ...isolated,
      runLoginShell: successfulLoginShell
    })

    expect(result.cliPath?.startsWith(testHome + path.sep)).toBe(true)
    expect(globalPaths.map(inspect)).toEqual(before)
  })
})
