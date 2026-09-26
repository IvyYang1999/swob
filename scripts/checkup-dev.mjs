#!/usr/bin/env node
/**
 * Development runner for the kernel checkup (task C1a deliverable 7).
 *
 *   node scripts/checkup-dev.mjs --home <dir> --state <empty tmp dir> --json <out.json> [--no-audit]
 *
 * Order (fail-closed): validate arguments → record the real home → metadata
 * audit snapshot → build the symlink HOME inside --state → set HOME/TMPDIR/
 * SWOB_* → only then evaluate the kernel bundle (the kernel captures HOME at
 * module load) → runKernelCheckup → privacy scan + schema validation → write
 * --json → remove only what this script created → audit comparison.
 *
 * Writes nothing outside --state and --json. stdout/stderr carry counts,
 * verdicts and reason codes only (plus `~/`-relative SQLite sidecar names in
 * the audit summary).
 */
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import { createRequire } from 'node:module'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const requireFromRoot = createRequire(path.join(ROOT, 'package.json'))
const EXIT = { usage: 2, privacy: 3, schema: 4, audit: 5, appRunning: 6, failure: 1 }

function out(line) { process.stdout.write(`${line}\n`) }
function fail(code, reason) {
  process.stderr.write(`checkup-dev: ${reason}\n`)
  process.exit(code)
}

function parseArgs(argv) {
  const args = { audit: true }
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index]
    if (flag === '--no-audit') { args.audit = false; continue }
    if (!['--home', '--state', '--json'].includes(flag) || index + 1 >= argv.length) fail(EXIT.usage, 'usage: --home <dir> --state <empty tmp dir> --json <out.json> [--no-audit]')
    args[flag.slice(2)] = argv[++index]
  }
  if (!args.home || !args.state || !args.json) fail(EXIT.usage, 'usage: --home <dir> --state <empty tmp dir> --json <out.json> [--no-audit]')
  return args
}

async function bundle(esbuild, contents) {
  const result = await esbuild.build({
    stdin: { contents, resolveDir: ROOT, sourcefile: 'checkup-dev-entry.ts', loader: 'ts' },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    external: ['better-sqlite3', 'electron'],
    write: false,
    logLevel: 'silent',
    legalComments: 'none'
  })
  return result.outputFiles[0].text
}

/** Evaluate a CJS bundle in memory; bare specifiers resolve from the worktree. */
function evaluate(code, virtualDir) {
  const module = { exports: {} }
  // eslint-disable-next-line no-new-func
  new Function('module', 'exports', 'require', '__filename', '__dirname', code)(
    module, module.exports, requireFromRoot, path.join(virtualDir, 'checkup-bundle.cjs'), virtualDir)
  return module.exports
}

// —— metadata-only audit (lstat; file contents are never read) ——
function metaSnapshot(root) {
  const entries = new Map()
  const walk = (dir) => {
    let names
    try { names = fs.readdirSync(dir) } catch { return }
    for (const name of names) {
      const full = path.join(dir, name)
      let stat
      try { stat = fs.lstatSync(full) } catch { continue }
      entries.set(full, `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.ino}`)
      if (stat.isDirectory()) walk(full)
    }
  }
  try {
    const stat = fs.lstatSync(root)
    entries.set(root, `${stat.isDirectory() ? 'dir' : stat.size}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.ino}`)
    if (stat.isDirectory()) walk(root)
  } catch { /* absent location: empty snapshot */ }
  return entries
}

function sameSnapshot(left, right) {
  if (left.size !== right.size) return false
  for (const [key, value] of left) if (right.get(key) !== value) return false
  return true
}

function auditTargets(home, libraryRoot) {
  const sqlite = []
  const codexHome = path.join(home, '.codex')
  try {
    for (const name of fs.readdirSync(codexHome)) if (/^state_\d+\.sqlite$/.test(name)) sqlite.push(path.join(codexHome, name))
  } catch { /* no codex */ }
  sqlite.push(path.join(home, '.local', 'share', 'opencode', 'opencode.db'), path.join(home, '.zcode', 'cli', 'db', 'db.sqlite'))
  return {
    groups: {
      stateDirUnchanged: path.join(home, '.claude-session-manager'),
      appSupportUnchanged: path.join(home, 'Library', 'Application Support', 'Swob'),
      libraryDotSwobUnchanged: libraryRoot ? path.join(libraryRoot, '.swob') : null
    },
    sqlite
  }
}

function takeAudit(targets) {
  const groups = {}
  for (const [key, location] of Object.entries(targets.groups)) groups[key] = location ? metaSnapshot(location) : new Map()
  const files = {}
  for (const main of targets.sqlite) {
    for (const suffix of ['', '-wal', '-shm', '-journal']) {
      const file = `${main}${suffix}`
      try {
        const stat = fs.lstatSync(file)
        files[file] = `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.ino}`
      } catch { files[file] = null }
    }
  }
  return { groups, files }
}

function compareAudit(before, after, targets, home) {
  const result = {}
  for (const key of Object.keys(targets.groups)) result[key] = sameSnapshot(before.groups[key], after.groups[key])
  result.sourceMainDbUnchanged = targets.sqlite.every((main) => before.files[main] === after.files[main])
  result.sidecarsTouched = Object.keys(before.files)
    .filter((file) => !targets.sqlite.includes(file) && before.files[file] !== after.files[file])
    .map((file) => `~/${path.relative(home, file).split(path.sep).join('/')}`)
  result.protectedEntries = Object.values(before.groups).reduce((sum, snapshot) => sum + snapshot.size, 0)
  return result
}

function kernelIdentity() {
  let version = '0.0.0-unknown'
  let commit = null
  try { version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version || version } catch { /* keep default */ }
  const head = spawnSync('git', ['-C', ROOT, 'rev-parse', 'HEAD'], { encoding: 'utf8' })
  if (head.status === 0 && /^[0-9a-f]{40}$/.test(head.stdout.trim())) commit = head.stdout.trim()
  return { version, commit }
}

async function main() {
  const startedAt = Date.now()
  const args = parseArgs(process.argv.slice(2))

  // 1. Validate arguments (fail closed).
  let realHome
  try {
    realHome = fs.realpathSync.native(args.home)
    if (!fs.statSync(realHome).isDirectory()) throw new Error('not a directory')
  } catch {
    fail(EXIT.usage, 'refused: --home must be an existing directory')
  }
  if (spawnSync('pgrep', ['-x', 'Swob']).status === 0) fail(EXIT.appRunning, 'refused: the Swob app is running (pgrep -x Swob)')

  // Pre-kernel helpers (no kernel module is evaluated by this bundle).
  const esbuild = requireFromRoot('esbuild')
  const isolation = evaluate(await bundle(esbuild, "export * from './src/checkup/isolated-home'\nexport { reportTargetVerdict } from './src/checkup/run-guard'\n"), ROOT)
  const verdict = isolation.validateStateDir({ stateDir: args.state, realHome })
  if (!verdict.ok) fail(EXIT.usage, `refused: --state ${verdict.reason}`)
  const stateDir = verdict.stateDir
  // --json may live under --home (e.g. a worktree's .working/) or in a normal directory of the library
  // root (the owner's vault), but never inside a source root, Swob's own state, App Support/Swob,
  // <library>/.swob, a session package or --state (shared rule: src/checkup/run-guard.ts).
  const target = isolation.reportTargetVerdict(args.json, { realHome, libraryRoot: isolation.configuredLibraryRoot(realHome), stateDir })
  if (!target.ok) fail(EXIT.usage, `refused: --json ${target.reason}`)
  const jsonReal = target.target

  // 2. Record the real home and take the metadata audit snapshot.
  const libraryRoot = isolation.configuredLibraryRoot(realHome)
  const targets = auditTargets(realHome, libraryRoot)
  const auditBefore = args.audit ? takeAudit(targets) : null

  // 3. Build the isolated HOME, 4. switch the environment, 5. only then evaluate the kernel.
  const isolated = isolation.buildIsolatedHome({ realHome, stateDir })
  const cleanup = () => {
    try { isolation.cleanupIsolatedHome(isolated) } catch { process.stderr.write('checkup-dev: cleanup incomplete\n') }
  }
  process.once('SIGINT', () => { cleanup(); process.exit(130) })
  let report
  let exitCode = 0
  try {
    for (const [key, value] of Object.entries(isolated.env)) process.env[key] = value
    for (const key of ['NODE_ENV', 'VITEST', 'SWOB_E2E_SANDBOX_ROOT', 'SWOB_TEST_HOME']) delete process.env[key]
    out(JSON.stringify({ isolatedHome: { linked: isolated.linked.length, missing: isolated.missing.length, codexHomesCopied: isolated.copiedCodexHomes } }))
    const kernel = evaluate(await bundle(esbuild, [
      "export { runKernelCheckup } from './src/checkup/run'",
      "export { scanForPrivacy } from './src/checkup/privacy'"
    ].join('\n')), stateDir)
    const identity = kernelIdentity()
    // 6. Run (read-only).
    report = await kernel.runKernelCheckup({ homeDir: realHome, stateDir, kernelVersion: identity.version, kernelCommit: identity.commit })
    // 7. Privacy scan and schema validation before anything is written.
    const scan = kernel.scanForPrivacy(report)
    if (!scan.ok) {
      out(JSON.stringify({ privacyScan: 'fail', hits: scan.hits.length, rules: [...new Set(scan.hits.map((hit) => hit.rule))] }))
      exitCode = EXIT.privacy
    } else {
      const Ajv2020 = requireFromRoot('ajv/dist/2020.js').default
      const schema = JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'checkup', 'contract', 'kernel-checkup-report-v1.schema.json'), 'utf8'))
      const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema)
      if (!validate(report)) {
        out(JSON.stringify({ schema: 'invalid', errors: (validate.errors || []).length }))
        exitCode = EXIT.schema
      } else {
        fs.writeFileSync(jsonReal, `${JSON.stringify(report, null, 2)}\n`)
      }
    }
  } finally {
    // 8. Remove only what this script created inside --state.
    cleanup()
  }
  const leftovers = fs.readdirSync(stateDir).length
  const summary = report ? {
    verdict: report.verdict,
    verdictReason: report.verdictReason ?? null,
    selfTest: report.kernel.selfTest,
    readout: report.readout,
    checks: report.checks.map((check) => `${check.id}:${check.verdict}`),
    units: report.units?.length ?? 0,
    kernelConsoleLines: report.diagnostics?.kernelConsoleLines ?? null,
    filesChangedDuringRun: report.diagnostics?.filesChangedDuringRun ?? null,
    timingsMs: { total: report.timingsMs.total }
  } : null
  out(JSON.stringify({ report: summary, written: exitCode === 0, stateDirLeftovers: leftovers, seconds: Math.round((Date.now() - startedAt) / 100) / 10 }))
  if (auditBefore) {
    const audit = compareAudit(auditBefore, takeAudit(targets), targets, realHome)
    out(JSON.stringify({ readonlyAudit: audit }))
    if (!audit.stateDirUnchanged || !audit.appSupportUnchanged || !audit.libraryDotSwobUnchanged || !audit.sourceMainDbUnchanged) exitCode ||= EXIT.audit
  }
  process.exit(exitCode)
}

main().catch((error) => {
  // Never echo messages or stacks: they may contain paths.
  process.stderr.write(`checkup-dev: failed (${error?.name ?? 'Error'}${error?.code ? ` ${error.code}` : ''})\n`)
  process.exit(EXIT.failure)
})
