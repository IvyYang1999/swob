#!/usr/bin/env node

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  DEFAULT_BOOTSTRAP_GATES,
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

assert.deepEqual(DEFAULT_BOOTSTRAP_GATES.map((gate) => gate.id), ['npm-ci'])
assert.deepEqual(DEFAULT_LAYER_GATES.map((gate) => gate.id), ['check'])
assert.deepEqual(DEFAULT_FULL_GATES.map((gate) => gate.id), ['check', 'vitest', 'build', 'e2e-non-windows'])
assert.equal(assertSafeGates([...DEFAULT_BOOTSTRAP_GATES, ...DEFAULT_LAYER_GATES, ...DEFAULT_FULL_GATES]), true)
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

  const divergentSha = execFileSync('git', ['commit-tree', `${baseSha}^{tree}`], {
    cwd: fixtureRepo,
    encoding: 'utf8',
    input: 'divergent base\n'
  }).trim()
  const divergentPreflight = preflightManifests([{
    workItemId: 'divergent-base',
    baseSha: divergentSha,
    headSha: divergentSha,
    changedFiles: [],
    contractsProduced: [],
    tests: [{ command: 'fixture', status: 'passed' }],
    visualEvidence: [],
    deviations: [],
    knownRisks: [],
    provenance: { harness: 'fixture', model: 'n/a', session: 'selftest' },
    depends_on: []
  }], fixtureRepo, { baseRef: 'master', staleThreshold: 20 })
  assert.ok(
    divergentPreflight.errors.some((error) => error.includes('禁止把旁支基线带入集成')),
    '旁支 baseSha 必须 fail-closed，不能只给 warning 后继续 merge'
  )

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
  const cleanPackage = createHead('clean-package', 'package.json', '{"private":true}\n')
  const conflictA = createHead('conflict-a', 'shared.txt', 'alpha\n')
  const conflictB = createHead('conflict-b', 'shared.txt', 'beta\n')
  runGit(fixtureRepo, 'switch', '-c', 'stacked-on-clean-a', cleanA)
  fs.writeFileSync(path.join(fixtureRepo, 'stacked.txt'), 'stacked\n')
  runGit(fixtureRepo, 'add', 'stacked.txt')
  runGit(fixtureRepo, 'commit', '-m', 'stacked-on-clean-a')
  const stackedHead = runGit(fixtureRepo, 'rev-parse', 'HEAD')
  runGit(fixtureRepo, 'switch', 'master')

  const manifestValue = (id, manifestBaseSha, headSha, changedFiles, dependency = []) => ({
    workItemId: id,
    baseSha: manifestBaseSha,
    headSha,
    changedFiles,
    contractsProduced: [],
    tests: [{ command: 'fixture', status: 'passed' }],
    visualEvidence: [],
    deviations: [],
    knownRisks: [],
    provenance: { harness: 'fixture', model: 'n/a', session: 'selftest' },
    depends_on: dependency
  })
  const stackedPreflight = preflightManifests([
    manifestValue('clean-a', baseSha, cleanA, ['a.txt']),
    manifestValue('stacked', cleanA, stackedHead, ['stacked.txt'], ['clean-a'])
  ], fixtureRepo, { baseRef: 'master', staleThreshold: 20 })
  assert.deepEqual(stackedPreflight.errors, [], '精确叠在已声明依赖 headSha 上的工作包应通过预检')
  const undeclaredStackPreflight = preflightManifests([
    manifestValue('clean-a', baseSha, cleanA, ['a.txt']),
    manifestValue('stacked', cleanA, stackedHead, ['stacked.txt'])
  ], fixtureRepo, { baseRef: 'master', staleThreshold: 20 })
  assert.ok(
    undeclaredStackPreflight.errors.some((error) => error.includes('禁止把旁支基线带入集成')),
    '未声明依赖的堆叠基线仍必须 fail-closed'
  )
  const manifestRoot = path.join(integrationFixture, 'manifests')
  fs.mkdirSync(manifestRoot)
  const writeManifest = (id, headSha, changedFiles, dependency = []) => {
    const file = path.join(manifestRoot, `${id}.json`)
    fs.writeFileSync(file, `${JSON.stringify(manifestValue(id, baseSha, headSha, changedFiles, dependency))}\n`)
    return file
  }
  const gates = [{ id: 'fixture-gate', command: 'node --version' }]
  const cleanResult = runMergeQueue({
    manifests: [
      writeManifest('clean-a', cleanA, ['a.txt']),
      writeManifest('clean-b', cleanB, ['b.txt'], ['clean-a']),
      writeManifest('clean-package', cleanPackage, ['package.json'], ['clean-b'])
    ],
    baseRef: 'master',
    staleThreshold: 20,
    integrationDir: path.join(integrationFixture, 'clean-worktree'),
    branch: 'integration/clean',
    reportPath: path.join(integrationFixture, 'clean-report.json'),
    bootstrapGates: gates,
    layerGates: gates,
    fullGates: gates
  }, fixtureRepo)
  assert.equal(cleanResult.exitCode, 0)
  assert.equal(cleanResult.report.canPush, true)
  assert.ok(cleanResult.report.items.every((item) => item.status === 'integrated'))
  assert.equal(cleanResult.report.items[0].bootstrapGates[0].status, 'passed')
  assert.equal(cleanResult.report.items[1].bootstrapGates.length, 0, '依赖清单未变化时应复用已安装依赖')
  assert.equal(cleanResult.report.items[2].bootstrapGates[0].status, 'passed', '依赖清单变化后必须重新引导')

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
    bootstrapGates: gates,
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
