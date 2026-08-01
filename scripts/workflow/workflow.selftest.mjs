#!/usr/bin/env node

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  DEFAULT_FULL_GATES,
  DEFAULT_LAYER_GATES,
  assertSafeGates,
  findPotentialConflicts,
  loadManifests,
  preflightManifests,
  runMergeQueue,
  topologicalOrder
} from './merge-queue.mjs'
import { validateFiles } from './swob-workflow.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(here, '../..')
const fixtures = path.join(here, 'fixtures')
const historical = JSON.parse(fs.readFileSync(path.join(fixtures, 'historical-batch.json'), 'utf8'))
const runGit = (directory, ...args) => execFileSync('git', args, { cwd: directory, encoding: 'utf8' }).trim()

const ordered = topologicalOrder(historical)
assert.deepEqual(ordered.map((item) => item.workItemId), [
  'tF25-ui-fixes',
  't-insights-stability',
  't-provider-runtime'
])
const conflicts = findPotentialConflicts(ordered)
assert.deepEqual(conflicts.map((item) => item.files), [['src/shared/i18n.ts'], ['src/main/index.ts']])

const preflight = preflightManifests(historical, repo, { baseRef: 'origin/master', staleThreshold: 0 })
assert.deepEqual(preflight.errors, [])
assert.ok(preflight.warnings.length > 0, '低 stale threshold 应接通陈旧基线警告')
assert.ok(preflight.potentialConflicts.every((item) => item.adjacent), '潜在冲突工作包应相邻')

assert.deepEqual(DEFAULT_LAYER_GATES.map((gate) => gate.id), ['check'])
assert.deepEqual(DEFAULT_FULL_GATES.map((gate) => gate.id), ['check', 'vitest', 'build', 'e2e-non-windows'])
assert.equal(assertSafeGates([...DEFAULT_LAYER_GATES, ...DEFAULT_FULL_GATES]), true)
assert.throws(() => assertSafeGates([{ id: 'bad', command: 'git push origin master' }]), /禁止/)
assert.throws(() => assertSafeGates([{ id: 'bad', command: 'vercel --prod' }]), /禁止/)
assert.throws(() => assertSafeGates([{ id: 'bad', command: 'npm publish' }]), /禁止/)

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-workflow-selftest-'))
try {
  for (const manifest of historical) {
    const directory = path.join(temporary, manifest.workItemId)
    fs.mkdirSync(directory)
    fs.writeFileSync(path.join(directory, 'result.json'), `${JSON.stringify(manifest)}\n`)
  }
  assert.equal(loadManifests([temporary]).length, historical.length, '目录扫描应递归发现 result.json')
  const dryRun = runMergeQueue({
    manifests: [temporary],
    baseRef: 'origin/master',
    staleThreshold: 20,
    dryRun: true,
    reportPath: path.join(temporary, 'report.json'),
    layerGates: DEFAULT_LAYER_GATES,
    fullGates: DEFAULT_FULL_GATES
  }, repo)
  assert.equal(dryRun.exitCode, 0)
  assert.deepEqual(dryRun.report.preflight.order, ordered.map((item) => item.workItemId))
  assert.equal(dryRun.report.integration, undefined, 'dry-run 不应创建集成 worktree')
} finally {
  fs.rmSync(temporary, { recursive: true, force: true })
}

const integrationFixture = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-merge-integration-'))
try {
  const fixtureRepo = path.join(integrationFixture, 'repo')
  fs.mkdirSync(fixtureRepo)
  runGit(fixtureRepo, 'init', '-b', 'master')
  runGit(fixtureRepo, 'config', 'user.name', 'Merge Queue Fixture')
  runGit(fixtureRepo, 'config', 'user.email', 'fixture@example.invalid')
  fs.writeFileSync(path.join(fixtureRepo, 'shared.txt'), 'base\n')
  runGit(fixtureRepo, 'add', '.')
  runGit(fixtureRepo, 'commit', '-m', 'fixture base')
  const baseSha = runGit(fixtureRepo, 'rev-parse', 'HEAD')

  const createHead = (branch, file, content) => {
    runGit(fixtureRepo, 'switch', '-c', branch, baseSha)
    fs.writeFileSync(path.join(fixtureRepo, file), content)
    runGit(fixtureRepo, 'add', file)
    runGit(fixtureRepo, 'commit', '-m', branch)
    const headSha = runGit(fixtureRepo, 'rev-parse', 'HEAD')
    runGit(fixtureRepo, 'switch', 'master')
    return headSha
  }
  const cleanA = createHead('clean-a', 'a.txt', 'a\n')
  const cleanB = createHead('clean-b', 'b.txt', 'b\n')
  const conflictA = createHead('conflict-a', 'shared.txt', 'alpha\n')
  const conflictB = createHead('conflict-b', 'shared.txt', 'beta\n')
  const manifestRoot = path.join(integrationFixture, 'manifests')
  fs.mkdirSync(manifestRoot)
  const writeManifest = (id, headSha, changedFiles, dependency = []) => {
    const file = path.join(manifestRoot, `${id}.json`)
    fs.writeFileSync(file, `${JSON.stringify({
      workItemId: id,
      baseSha,
      headSha,
      changedFiles,
      contractsProduced: [],
      tests: [{ command: 'fixture', status: 'passed' }],
      visualEvidence: [],
      deviations: [],
      knownRisks: [],
      provenance: { harness: 'fixture', model: 'n/a', session: 'selftest' },
      depends_on: dependency
    })}\n`)
    return file
  }
  const gates = [{ id: 'fixture-gate', command: 'node --version' }]
  const cleanResult = runMergeQueue({
    manifests: [writeManifest('clean-a', cleanA, ['a.txt']), writeManifest('clean-b', cleanB, ['b.txt'], ['clean-a'])],
    baseRef: 'master',
    staleThreshold: 20,
    integrationDir: path.join(integrationFixture, 'clean-worktree'),
    branch: 'integration/clean',
    reportPath: path.join(integrationFixture, 'clean-report.json'),
    layerGates: gates,
    fullGates: gates
  }, fixtureRepo)
  assert.equal(cleanResult.exitCode, 0)
  assert.equal(cleanResult.report.canPush, true)
  assert.ok(cleanResult.report.items.every((item) => item.status === 'integrated'))

  const conflictResult = runMergeQueue({
    manifests: [
      writeManifest('conflict-a', conflictA, ['shared.txt']),
      writeManifest('conflict-b', conflictB, ['shared.txt'], ['conflict-a'])
    ],
    baseRef: 'master',
    staleThreshold: 20,
    integrationDir: path.join(integrationFixture, 'conflict-worktree'),
    branch: 'integration/conflict',
    reportPath: path.join(integrationFixture, 'conflict-report.json'),
    layerGates: gates,
    fullGates: gates
  }, fixtureRepo)
  assert.equal(conflictResult.exitCode, 2)
  assert.equal(conflictResult.report.items[1].status, 'paused-conflict')
  assert.equal(conflictResult.report.items[1].conflicts[0].file, 'shared.txt')
  assert.ok(conflictResult.report.items[1].conflicts[0].current.top.length > 0)
  assert.ok(conflictResult.report.items[1].conflicts[0].incoming.top.length > 0)
} finally {
  fs.rmSync(integrationFixture, { recursive: true, force: true })
}

const good = validateFiles([path.join(fixtures, 'good-graph.yaml')])[0]
assert.deepEqual(good.errors, [])
assert.equal(good.warnings.length, 1, '重叠 write_scope 应警告但不失败')
const bad = validateFiles([path.join(fixtures, 'bad-graph.yaml')])[0]
assert.ok(bad.errors.some((error) => error.includes('存在环')))
assert.ok(bad.errors.some((error) => error.includes('Owner 重复')))
assert.ok(bad.errors.some((error) => error.includes('evidence_required')))

process.stdout.write('workflow selftest: sorting/conflict/gates/history/graph fixtures passed\n')
