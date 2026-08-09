import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  assertAllowedGlobalModulePaths,
  assertNoAncestorNodeModules
} from './packaged-cli-isolation.mjs'

const isolationScript = fileURLToPath(new URL('./packaged-cli-isolation.mjs', import.meta.url))

test('rejects node_modules on the physical ancestor chain behind a lexical alias', () => {
  const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-cli-isolation-'))
  try {
    const physicalRoot = path.join(testRoot, 'physical')
    const physicalCliDirectory = path.join(physicalRoot, 'nested', 'cli')
    const lexicalCliDirectory = path.join(testRoot, 'alias')
    const physicalCli = path.join(physicalCliDirectory, 'cli.js')
    const lexicalCli = path.join(lexicalCliDirectory, 'cli.js')

    fs.mkdirSync(physicalCliDirectory, { recursive: true })
    fs.writeFileSync(physicalCli, '')
    fs.symlinkSync(physicalCliDirectory, lexicalCliDirectory, 'dir')

    assert.doesNotThrow(() => assertNoAncestorNodeModules(lexicalCli))

    fs.mkdirSync(path.join(physicalRoot, 'node_modules'))
    assert.throws(
      () => assertNoAncestorNodeModules(lexicalCli),
      /ambient node_modules ancestors/
    )
  } finally {
    fs.rmSync(testRoot, { recursive: true, force: true })
  }
})

test('rejects an existing ambient CommonJS global module path', () => {
  const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-cli-global-isolation-'))
  try {
    const resources = path.join(testRoot, 'Swob.app', 'Contents', 'Resources')
    const packagedCli = path.join(resources, 'cli', 'cli.js')
    const packagedNodeModules = path.join(resources, 'app.asar.unpacked', 'node_modules')
    const ambientNodeModules = path.join(testRoot, 'ambient-prefix', 'lib', 'node')
    const fixtureHome = path.join(testRoot, 'home')
    for (const directory of [path.dirname(packagedCli), packagedNodeModules, ambientNodeModules, fixtureHome]) {
      fs.mkdirSync(directory, { recursive: true })
    }
    fs.writeFileSync(packagedCli, '')

    const previousNodePath = process.env.NODE_PATH
    process.env.NODE_PATH = packagedNodeModules
    try {
      assert.throws(
        () => assertAllowedGlobalModulePaths(
          packagedNodeModules,
          [packagedNodeModules, ambientNodeModules]
        ),
        /ambient global module paths/
      )
    } finally {
      if (previousNodePath === undefined) delete process.env.NODE_PATH
      else process.env.NODE_PATH = previousNodePath
    }

    const result = spawnSync(
      process.execPath,
      [isolationScript, packagedCli, packagedNodeModules],
      {
        encoding: 'utf8',
        env: {
          PATH: process.env.PATH,
          HOME: fixtureHome,
          NODE_OPTIONS: '',
          NODE_PATH: [packagedNodeModules, ambientNodeModules].join(path.delimiter)
        }
      }
    )

    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /NODE_PATH must contain only the packaged node_modules directory/)

    const preloaded = spawnSync(
      process.execPath,
      [isolationScript, packagedCli, packagedNodeModules],
      {
        encoding: 'utf8',
        env: {
          PATH: process.env.PATH,
          HOME: fixtureHome,
          NODE_OPTIONS: '--no-warnings',
          NODE_PATH: packagedNodeModules
        }
      }
    )
    assert.notEqual(preloaded.status, 0)
    assert.match(preloaded.stderr, /NODE_OPTIONS must be empty/)
  } finally {
    fs.rmSync(testRoot, { recursive: true, force: true })
  }
})
