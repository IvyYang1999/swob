import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AppUpdater } from 'electron-updater'

type UpdateListener = (...args: any[]) => void

type E2EUpdater = Pick<
  AppUpdater,
  'channel' | 'allowDowngrade' | 'on' | 'checkForUpdates' | 'downloadUpdate' | 'quitAndInstall'
>

type E2EApp = {
  isPackaged: boolean
  getVersion: () => string
  getPath: (name: 'userData') => string
  quit: () => void
}

type UpdateE2EState = {
  createdAt: string
  phase: 'checking' | 'downloading' | 'installing'
  fromVersion: string
  targetVersion: string
  resultFile: string
}

type UpdateE2EResult = {
  result: 'passed' | 'failed'
  fromVersion: string
  targetVersion: string
  installedVersion: string
  phase: string
  error?: string
  finishedAt: string
}

export const UPDATE_E2E_CHANNEL = 'swob-canary'
export const UPDATE_E2E_STATE_FILE = 'swob-update-e2e-state.json'
const MAX_STATE_AGE_MS = 60 * 60 * 1000

function isPathWithin(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate))
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

function isSafeResultFile(fileName: string): boolean {
  if (!path.isAbsolute(fileName) || path.extname(fileName) !== '.json') return false
  return [os.tmpdir(), '/private/tmp', '/tmp'].some((root) => isPathWithin(root, fileName))
}

function readState(stateFile: string): UpdateE2EState | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile, 'utf8')) as UpdateE2EState
    if (!parsed || !isSafeResultFile(parsed.resultFile)) return null
    if (!['checking', 'downloading', 'installing'].includes(parsed.phase)) return null
    return parsed
  } catch {
    return null
  }
}

function writeState(stateFile: string, state: UpdateE2EState): void {
  fs.mkdirSync(path.dirname(stateFile), { recursive: true, mode: 0o700 })
  fs.writeFileSync(stateFile, `${JSON.stringify(state)}\n`, { encoding: 'utf8', mode: 0o600 })
}

function writeResult(state: UpdateE2EState, result: UpdateE2EResult): void {
  fs.mkdirSync(path.dirname(state.resultFile), { recursive: true, mode: 0o700 })
  fs.writeFileSync(state.resultFile, `${JSON.stringify(result)}\n`, { encoding: 'utf8', mode: 0o600 })
}

function removeState(stateFile: string): void {
  try { fs.unlinkSync(stateFile) } catch { /* no pending E2E state */ }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Dedicated, opt-in driver for a real packaged Squirrel.Mac update test.
 * It never runs in development or normal user launches. The canary channel is
 * hard-coded so this hook cannot redirect production users to an arbitrary feed.
 */
export function startPackagedUpdateE2E({
  app,
  updater,
  env = process.env,
  now = () => new Date()
}: {
  app: E2EApp
  updater: E2EUpdater
  env?: NodeJS.ProcessEnv
  now?: () => Date
}): boolean {
  if (!app.isPackaged) return false

  const stateFile = path.join(app.getPath('userData'), UPDATE_E2E_STATE_FILE)
  const pending = readState(stateFile)
  const currentVersion = app.getVersion()

  if (pending?.phase === 'installing') {
    const passed = currentVersion === pending.targetVersion
    writeResult(pending, {
      result: passed ? 'passed' : 'failed',
      fromVersion: pending.fromVersion,
      targetVersion: pending.targetVersion,
      installedVersion: currentVersion,
      phase: 'relaunch',
      ...(passed ? {} : { error: 'Installed version did not match the E2E target after relaunch.' }),
      finishedAt: now().toISOString()
    })
    removeState(stateFile)
    app.quit()
    return true
  }

  if (pending) {
    const age = now().getTime() - new Date(pending.createdAt).getTime()
    const expired = Number.isFinite(age) && age > MAX_STATE_AGE_MS
    writeResult(pending, {
      result: 'failed',
      fromVersion: pending.fromVersion,
      targetVersion: pending.targetVersion,
      installedVersion: currentVersion,
      phase: pending.phase,
      error: expired
        ? 'Previous update E2E state expired before installation.'
        : 'Previous update E2E process exited before installation.',
      finishedAt: now().toISOString()
    })
    removeState(stateFile)
    app.quit()
    return true
  }

  if (env.SWOB_UPDATE_E2E !== '1') return false

  const targetVersion = env.SWOB_UPDATE_E2E_TARGET_VERSION || ''
  const resultFile = env.SWOB_UPDATE_E2E_RESULT_FILE || ''
  const channel = env.SWOB_UPDATE_E2E_CHANNEL || ''
  if (!targetVersion || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(targetVersion)) return false
  if (!isSafeResultFile(resultFile)) return false
  if (channel !== UPDATE_E2E_CHANNEL) return false

  const state: UpdateE2EState = {
    createdAt: now().toISOString(),
    phase: 'checking',
    fromVersion: currentVersion,
    targetVersion,
    resultFile
  }
  writeState(stateFile, state)
  let settled = false

  const fail = (phase: string, error: unknown): void => {
    if (settled) return
    settled = true
    writeResult(state, {
      result: 'failed',
      fromVersion: state.fromVersion,
      targetVersion: state.targetVersion,
      installedVersion: app.getVersion(),
      phase,
      error: errorMessage(error),
      finishedAt: now().toISOString()
    })
    removeState(stateFile)
    app.quit()
  }

  updater.channel = UPDATE_E2E_CHANNEL
  updater.allowDowngrade = false
  updater.on('error', (error) => fail(state.phase, error))
  updater.on('update-not-available', () => fail('checking', new Error(`Target ${targetVersion} was not available.`)))
  updater.on('update-available', (info: { version?: string }) => {
    if (info.version !== targetVersion) {
      fail('checking', new Error(`Expected ${targetVersion}, feed offered ${info.version || '<empty>'}.`))
      return
    }
    state.phase = 'downloading'
    writeState(stateFile, state)
    void updater.downloadUpdate().catch((error) => fail('downloading', error))
  })
  updater.on('update-downloaded', (info: { version?: string }) => {
    if (settled) return
    if (info.version && info.version !== targetVersion) {
      fail('downloading', new Error(`Downloaded ${info.version}, expected ${targetVersion}.`))
      return
    }
    settled = true
    state.phase = 'installing'
    writeState(stateFile, state)
    updater.quitAndInstall()
  })

  void updater.checkForUpdates().catch((error) => fail('checking', error))
  return true
}
