import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'
import { assertNoAncestorNodeModules } from './packaged-cli-isolation.mjs'

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
