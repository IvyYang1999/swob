#!/usr/bin/env node

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createPackage } from '@electron/asar'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-package-policy-'))
const sourceRoot = path.join(tempRoot, 'source')
const resourcesRoot = path.join(tempRoot, 'resources')
const asarPath = path.join(resourcesRoot, 'app.asar')
const inventoryRoot = path.join(tempRoot, 'inventory')

function write(relative, content = 'fixture\n') {
  const target = path.join(sourceRoot, relative)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, content)
}

function copyNotice(source, name) {
  fs.copyFileSync(source, path.join(resourcesRoot, name))
}

function runCheck() {
  return spawnSync(process.execPath, [
    path.join(repoRoot, 'scripts/check-package.mjs'),
    '--asar', asarPath,
    '--inventory-dir', inventoryRoot,
  ], { cwd: repoRoot, encoding: 'utf8' })
}

try {
  fs.mkdirSync(resourcesRoot, { recursive: true })
  write('package.json', '{}\n')
  write('LICENSE')
  write('THIRD_PARTY_NOTICES')
  write('out/main/index.js')
  write('out/preload/index.js')
  write('out/renderer/index.html')
  copyNotice(path.join(repoRoot, 'LICENSE'), 'LICENSE.txt')
  copyNotice(path.join(repoRoot, 'THIRD_PARTY_NOTICES'), 'THIRD_PARTY_NOTICES')
  copyNotice(path.join(repoRoot, 'node_modules/electron/dist/LICENSE'), 'LICENSE.electron.txt')
  copyNotice(path.join(repoRoot, 'node_modules/electron/dist/LICENSES.chromium.html'), 'LICENSES.chromium.html')

  await createPackage(sourceRoot, asarPath)
  const clean = runCheck()
  assert.equal(clean.status, 0, clean.stderr || clean.stdout)

  write('.claude/settings.local.json', '{"private":true}\n')
  await createPackage(sourceRoot, asarPath)
  const dirty = runCheck()
  assert.notEqual(dirty.status, 0, 'dirty package unexpectedly passed')
  assert.match(dirty.stderr, /\.claude\/settings\.local\.json/)

  fs.rmSync(path.join(sourceRoot, '.claude'), { recursive: true })
  await createPackage(sourceRoot, asarPath)
  fs.mkdirSync(path.join(resourcesRoot, '.claude'), { recursive: true })
  fs.writeFileSync(path.join(resourcesRoot, '.claude/settings.local.json'), '{"private":true}\n')
  const dirtyOuter = runCheck()
  assert.notEqual(dirtyOuter.status, 0, 'dirty outer payload unexpectedly passed')
  assert.match(dirtyOuter.stderr, /outer payload contains private segment \.claude/)
  console.log('Package policy self-test passed: clean fixture accepted; private settings rejected in asar and outer payload.')
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true })
}
