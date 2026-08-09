import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

if (process.env.NODE_OPTIONS) {
  throw new Error('NODE_OPTIONS must be empty before building and verifying the packaged CLI')
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    env: { ...process.env, ...options.env },
    stdio: 'inherit'
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    process.exitCode = result.status ?? 1
    throw new Error(`${path.basename(command)} exited with status ${result.status ?? 1}`)
  }
}

if (process.platform !== 'darwin') {
  process.stderr.write('Packaged CLI contract currently requires a native macOS runner.\n')
  process.exit(1)
}

run(process.execPath, ['--test', 'scripts/packaged-cli-isolation.selftest.mjs'])
run('npm', ['run', 'build'])
run(path.join(root, 'node_modules', '.bin', 'electron-builder'), [
  '--dir', '--mac', `--${process.arch}`, '--publish', 'never',
  '--config.mac.identity=null', '--config.mac.notarize=false'
])

const appPath = path.join(root, 'dist', process.arch === 'arm64' ? 'mac-arm64' : 'mac', 'Swob.app')
const cliPath = path.join(appPath, 'Contents', 'Resources', 'cli', 'cli.js')
if (!fs.existsSync(cliPath)) {
  process.stderr.write(`Packaged CLI missing: ${cliPath}\n`)
  process.exit(1)
}

// Running this app in dist/ would let Node walk up to the checkout's
// node_modules and hide missing packaged dependencies. Exercise a detached,
// installation-shaped resource tree instead.
const detachedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-packaged-cli-detached-'))
const detachedApp = path.join(detachedRoot, 'Swob.app')
const sourceResources = path.join(appPath, 'Contents', 'Resources')
const detachedResources = path.join(detachedApp, 'Contents', 'Resources')
try {
  fs.mkdirSync(detachedResources, { recursive: true })
  fs.cpSync(path.join(sourceResources, 'cli'), path.join(detachedResources, 'cli'), { recursive: true })
  fs.cpSync(
    path.join(sourceResources, 'app.asar.unpacked'),
    path.join(detachedResources, 'app.asar.unpacked'),
    { recursive: true }
  )
  const detachedCli = path.join(detachedResources, 'cli', 'cli.js')
  const detachedNodeModules = path.join(detachedResources, 'app.asar.unpacked', 'node_modules')
  const detachedHome = path.join(detachedRoot, 'home')
  fs.mkdirSync(detachedHome)
  run(process.execPath, [
    'scripts/packaged-cli-isolation.mjs', detachedCli, detachedNodeModules
  ], {
    env: {
      HOME: detachedHome,
      NODE_OPTIONS: '',
      NODE_PATH: detachedNodeModules
    }
  })
  run(path.join(root, 'node_modules', '.bin', 'vitest'), [
    'run', 'src/cli/packaged-contract.test.ts', '--maxWorkers=1'
  ], {
    env: { NODE_OPTIONS: '', SWOB_PACKAGED_APP: detachedApp }
  })
} finally {
  fs.rmSync(detachedRoot, { recursive: true, force: true })
}
