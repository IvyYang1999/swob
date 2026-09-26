import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { typescriptRuntimeDependencyClosure } from '../main/__test-support__/typescript-runtime-closure'
import { protectedLocations, validateStateDir } from './isolated-home'
import { SESSION_PACKAGE_MARKER, readMachineModel, reportTargetVerdict, type ReportTargetContext } from './run-guard'
import { MACHINE_MODEL } from './privacy'

const dirs: string[] = []
function tempDir(prefix: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function mkdir(...segments: string[]): string {
  const dir = path.join(...segments)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

/** A synthetic home whose configured library root is a whole vault (like the owner's machine). */
function layout(): { home: string; vault: string; stateDir: string; elsewhere: string; context: ReportTargetContext } {
  const home = tempDir('run-guard-home-')
  const vault = mkdir(home, 'Vaults', 'main')
  const stateDir = tempDir('run-guard-state-')
  const elsewhere = tempDir('run-guard-elsewhere-')
  mkdir(home, '.claude', 'projects')
  mkdir(home, '.codex', 'sessions')
  mkdir(home, '.qoderwork', 'projects')
  mkdir(home, '.claude-session-manager')
  mkdir(home, 'Library', 'Application Support', 'Swob')
  mkdir(vault, '.swob', 'index')
  mkdir(vault, '项目', '体检')
  const pkg = mkdir(vault, 'Swob', 'sessions', 'pkg-1')
  fs.writeFileSync(path.join(pkg, SESSION_PACKAGE_MARKER), '{}')
  mkdir(pkg, 'attachments')
  // A source root that is itself a link to data living elsewhere.
  mkdir(elsewhere, 'cursor-data')
  fs.symlinkSync(path.join(elsewhere, 'cursor-data'), path.join(home, '.cursor'))
  return { home, vault, stateDir, elsewhere, context: { realHome: home, libraryRoot: vault, stateDir } }
}

describe('reportTargetVerdict', () => {
  it('allows ordinary directories of the library root (the vault), the home and the library root itself', () => {
    const { home, vault, context } = layout()
    const inVault = reportTargetVerdict(path.join(vault, '项目', '体检'), { ...context, kind: 'directory' })
    expect(inVault).toEqual({ ok: true, target: path.join(vault, '项目', '体检'), directory: path.join(vault, '项目', '体检') })
    expect(reportTargetVerdict(path.join(vault, '项目', '体检', 'report.md'), context))
      .toEqual({ ok: true, target: path.join(vault, '项目', '体检', 'report.md'), directory: path.join(vault, '项目', '体检') })
    expect(reportTargetVerdict(vault, { ...context, kind: 'directory' }).ok).toBe(true)
    expect(reportTargetVerdict(path.join(vault, 'Swob', 'sessions', 'notes.md'), context).ok).toBe(true)
    mkdir(home, 'reports')
    expect(reportTargetVerdict(path.join(home, 'reports', 'baseline.json'), context).ok).toBe(true)
    expect(reportTargetVerdict(path.join(home, 'baseline.json'), context).ok).toBe(true)
  })

  it('refuses the library state, session packages and anything below them', () => {
    const { vault, context } = layout()
    const pkg = path.join(vault, 'Swob', 'sessions', 'pkg-1')
    expect(reportTargetVerdict(path.join(vault, '.swob', 'x.json'), context)).toEqual({ ok: false, reason: 'report-target-in-library-state' })
    expect(reportTargetVerdict(path.join(vault, '.swob', 'index'), { ...context, kind: 'directory' })).toEqual({ ok: false, reason: 'report-target-in-library-state' })
    expect(reportTargetVerdict(path.join(vault, '.swob'), context)).toEqual({ ok: false, reason: 'report-target-not-file' })
    expect(reportTargetVerdict(path.join(pkg, 'x.md'), context)).toEqual({ ok: false, reason: 'report-target-in-session-package' })
    expect(reportTargetVerdict(path.join(pkg, 'attachments'), { ...context, kind: 'directory' })).toEqual({ ok: false, reason: 'report-target-in-session-package' })
    expect(reportTargetVerdict(path.join(vault, '项目', SESSION_PACKAGE_MARKER), context)).toEqual({ ok: false, reason: 'report-target-in-session-package' })
  })

  it('refuses source roots (also through a linked root), Swob state, App Support/Swob and the stateDir', () => {
    const { home, elsewhere, stateDir, context } = layout()
    expect(reportTargetVerdict(path.join(home, '.claude', 'projects', 'x.md'), context)).toEqual({ ok: false, reason: 'report-target-in-source-root' })
    expect(reportTargetVerdict(path.join(home, '.codex', 'x.json'), context)).toEqual({ ok: false, reason: 'report-target-in-source-root' })
    expect(reportTargetVerdict(path.join(home, '.qoderwork', 'projects'), { ...context, kind: 'directory' })).toEqual({ ok: false, reason: 'report-target-in-source-root' })
    expect(reportTargetVerdict(path.join(elsewhere, 'cursor-data', 'x.md'), context)).toEqual({ ok: false, reason: 'report-target-in-source-root' })
    expect(reportTargetVerdict(path.join(home, '.claude-session-manager', 'x.md'), context)).toEqual({ ok: false, reason: 'report-target-in-swob-state' })
    expect(reportTargetVerdict(path.join(home, 'Library', 'Application Support', 'Swob', 'x.md'), context)).toEqual({ ok: false, reason: 'report-target-in-app-support' })
    expect(reportTargetVerdict(path.join(stateDir, 'x.json'), context)).toEqual({ ok: false, reason: 'report-target-in-state-dir' })
    expect(reportTargetVerdict(stateDir, { ...context, kind: 'directory' })).toEqual({ ok: false, reason: 'report-target-in-state-dir' })
  })

  it('refuses missing or linked targets and never creates anything', () => {
    const { home, vault, elsewhere, context } = layout()
    expect(reportTargetVerdict(path.join(vault, 'missing', 'x.md'), context)).toEqual({ ok: false, reason: 'report-target-missing' })
    expect(reportTargetVerdict(path.join(vault, 'missing'), { ...context, kind: 'directory' })).toEqual({ ok: false, reason: 'report-target-missing' })
    expect(fs.existsSync(path.join(vault, 'missing'))).toBe(false)
    fs.writeFileSync(path.join(vault, 'plain.md'), 'x')
    expect(reportTargetVerdict(path.join(vault, 'plain.md'), { ...context, kind: 'directory' })).toEqual({ ok: false, reason: 'report-target-not-directory' })
    fs.symlinkSync(elsewhere, path.join(vault, 'linked-dir'))
    expect(reportTargetVerdict(path.join(vault, 'linked-dir'), { ...context, kind: 'directory' })).toEqual({ ok: false, reason: 'report-target-symlink' })
    expect(reportTargetVerdict(path.join(vault, 'linked-dir', 'x.md'), context)).toEqual({ ok: false, reason: 'report-target-symlink' })
    fs.symlinkSync(path.join(elsewhere, 'target.md'), path.join(vault, 'linked.md'))
    expect(reportTargetVerdict(path.join(vault, 'linked.md'), context)).toEqual({ ok: false, reason: 'report-target-symlink' })
    expect(fs.existsSync(path.join(elsewhere, 'target.md'))).toBe(false)
    expect(reportTargetVerdict(path.join(home, 'x.md'), { ...context, libraryRoot: null, stateDir: null }).ok).toBe(true)
  })

  it('leaves the stateDir guard of isolated-home untouched (the whole library root stays protected there)', () => {
    const { home, vault } = layout()
    fs.writeFileSync(path.join(home, '.claude-session-manager', 'app-config.json'), JSON.stringify({ libraryPath: vault }))
    expect(protectedLocations(home)).toContain(vault)
    const insideVault = mkdir(vault, 'state')
    expect(validateStateDir({ stateDir: insideVault, realHome: home, allowedRoots: [home] })).toEqual({ ok: false, reason: 'state-dir-overlaps-protected' })
  })
})

describe('run-guard.ts architecture', () => {
  it('imports no kernel module (the dev runner evaluates it before the kernel)', () => {
    const closure = typescriptRuntimeDependencyClosure(path.join(process.cwd(), 'src', 'checkup', 'run-guard.ts'))
      .map((fileName) => path.relative(process.cwd(), fileName).split(path.sep).join('/'))
      .sort()
    expect(closure).toEqual(['src/checkup/isolated-home.ts', 'src/checkup/run-guard.ts'])
  })
})

describe('readMachineModel (report header, dispatcher decision 3)', () => {
  it('returns a plain Mac model id and nothing else', () => {
    expect(readMachineModel('darwin', () => 'Mac16,10\n')).toBe('Mac16,10')
    expect(readMachineModel('darwin', () => 'MacBookPro18,3')).toBe('MacBookPro18,3')
    expect(readMachineModel('darwin', () => null)).toBeNull()
    expect(readMachineModel('darwin', () => "yyt's Mac mini")).toBeNull()
    expect(readMachineModel('darwin', () => 'Mac16,10\nextra')).toBeNull()
    expect(readMachineModel('linux', () => 'Mac16,10')).toBeNull()
    expect(readMachineModel('win32', () => 'Mac16,10')).toBeNull()
  })

  it('agrees with the Markdown scanner shape, and reads this Mac when there is one', () => {
    for (const model of ['Mac16,10', 'MacBookPro18,3', 'iMac21,1']) expect(MACHINE_MODEL.test(model), model).toBe(true)
    const local = readMachineModel()
    if (local !== null) expect(local).toMatch(MACHINE_MODEL)
  })
})
