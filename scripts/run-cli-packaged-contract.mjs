import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    env: { ...process.env, ...options.env },
    stdio: 'inherit'
  })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}

if (process.platform !== 'darwin') {
  process.stderr.write('Packaged CLI contract currently requires a native macOS runner.\n')
  process.exit(1)
}

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

run(path.join(root, 'node_modules', '.bin', 'vitest'), [
  'run', 'src/cli/packaged-contract.test.ts', '--maxWorkers=1'
], {
  env: { SWOB_PACKAGED_APP: appPath }
})
