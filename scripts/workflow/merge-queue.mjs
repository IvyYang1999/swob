#!/usr/bin/env node

import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const DEFAULT_LAYER_GATES = [
  { id: 'check', command: 'npm run check' }
]

export const DEFAULT_BOOTSTRAP_GATES = [
  { id: 'npm-ci', command: 'npm ci' }
]

export const DEFAULT_FULL_GATES = [
  { id: 'check', command: 'npm run check' },
  { id: 'vitest', command: 'npx vitest run --maxWorkers=2' },
  { id: 'build', command: 'npm run build' },
  {
    id: 'e2e-non-windows',
    command: 'npx playwright test --grep-invert "installed x64 app discovers only supported USERPROFILE sources and renders Windows UI"'
  }
]

const FORBIDDEN_GATE = /\b(?:git\s+push|(?:npm|pnpm|yarn)\s+(?:run\s+)?(?:deploy|publish)|deploy-local|vercel\b|netlify\b|gh\s+release|electron-builder\b[^\n]*--publish(?!\s+never))\b/i
const SCAN_SKIP = new Set(['.git', 'node_modules', 'out', 'dist', 'release'])

function git(args, cwd, options = {}) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: options.stdio ?? ['ignore', 'pipe', 'pipe'] }).trim()
}

function gitResult(args, cwd) {
  return spawnSync('git', args, { cwd, encoding: 'utf8' })
}

function normalizedFiles(files) {
  return [...new Set(files.map((entry) => entry.replaceAll('\\', '/')))].sort()
}

function dependenciesOf(manifest) {
  const value = manifest.depends_on ?? manifest.dependsOn ?? []
  return Array.isArray(value) ? value : []
}

function overlaps(left, right) {
  const rightFiles = new Set(right.changedFiles)
  return left.changedFiles.filter((file) => rightFiles.has(file))
}

function changesDependencyManifest(manifest) {
  return manifest.changedFiles.some((file) =>
    /(^|\/)(?:package(?:-lock)?\.json|npm-shrinkwrap\.json)$/.test(file)
  )
}

export function validateManifestShape(manifest, source = '<memory>') {
  const errors = []
  for (const key of ['workItemId', 'baseSha', 'headSha']) {
    if (typeof manifest[key] !== 'string' || !manifest[key].trim()) errors.push(`${source}: 缺少 ${key}`)
  }
  for (const key of ['changedFiles', 'contractsProduced', 'visualEvidence', 'deviations', 'knownRisks']) {
    if (!Array.isArray(manifest[key])) errors.push(`${source}: ${key} 必须是数组`)
  }
  if (Array.isArray(manifest.changedFiles) && manifest.changedFiles.some((file) => typeof file !== 'string' || !file.trim())) {
    errors.push(`${source}: changedFiles 只能包含非空路径`)
  }
  if (!Array.isArray(manifest.tests) || manifest.tests.length === 0) {
    errors.push(`${source}: tests 必须包含至少一项证据`)
  } else {
    for (const [index, test] of manifest.tests.entries()) {
      if (!test || typeof test.command !== 'string' || !test.command.trim() || test.status !== 'passed') {
        errors.push(`${source}: tests[${index}] 必须包含 command 且 status=passed`)
      }
    }
  }
  if (!manifest.provenance || typeof manifest.provenance !== 'object') {
    errors.push(`${source}: 缺少 provenance`)
  } else {
    for (const key of ['harness', 'model', 'session']) {
      if (typeof manifest.provenance[key] !== 'string' || !manifest.provenance[key].trim()) errors.push(`${source}: provenance.${key} 必须是非空字符串`)
    }
  }
  const rawDependencies = manifest.depends_on ?? manifest.dependsOn ?? []
  if (!Array.isArray(rawDependencies)) errors.push(`${source}: depends_on 必须是数组`)
  else if (rawDependencies.some((id) => typeof id !== 'string' || !id.trim())) errors.push(`${source}: depends_on 只能包含工作包 ID`)
  return errors
}

export function findPotentialConflicts(manifests) {
  const conflicts = []
  for (let left = 0; left < manifests.length; left += 1) {
    for (let right = left + 1; right < manifests.length; right += 1) {
      const files = overlaps(manifests[left], manifests[right])
      if (files.length > 0) {
        conflicts.push({
          left: manifests[left].workItemId,
          right: manifests[right].workItemId,
          files: normalizedFiles(files)
        })
      }
    }
  }
  return conflicts
}

export function topologicalOrder(manifests) {
  const byId = new Map(manifests.map((manifest) => [manifest.workItemId, manifest]))
  if (byId.size !== manifests.length) throw new Error('workItemId 重复')
  for (const manifest of manifests) {
    for (const dependency of dependenciesOf(manifest)) {
      if (!byId.has(dependency)) throw new Error(`${manifest.workItemId} 依赖未提供的工作包 ${dependency}`)
    }
  }

  const remaining = new Set(byId.keys())
  const completed = new Set()
  const ordered = []
  while (remaining.size > 0) {
    const ready = [...remaining]
      .map((id) => byId.get(id))
      .filter((manifest) => dependenciesOf(manifest).every((id) => completed.has(id)))
    if (ready.length === 0) throw new Error(`depends_on 存在环: ${[...remaining].sort().join(', ')}`)

    const previous = ordered.at(-1)
    ready.sort((left, right) => {
      const leftOverlap = previous ? overlaps(previous, left).length : 0
      const rightOverlap = previous ? overlaps(previous, right).length : 0
      return rightOverlap - leftOverlap || left.workItemId.localeCompare(right.workItemId)
    })
    const selected = ready[0]
    ordered.push(selected)
    remaining.delete(selected.workItemId)
    completed.add(selected.workItemId)
  }
  return ordered
}

function verifyCommit(repo, sha, label) {
  const result = gitResult(['cat-file', '-e', `${sha}^{commit}`], repo)
  if (result.status !== 0) throw new Error(`${label} 不存在或不是 commit: ${sha}`)
}

export function preflightManifests(manifests, repo, { baseRef = 'origin/master', staleThreshold = 20 } = {}) {
  const errors = []
  const warnings = []
  const ids = new Set()
  const manifestsById = new Map(manifests.map((manifest) => [manifest.workItemId, manifest]))
  for (const manifest of manifests) {
    const source = manifest.__source ?? manifest.workItemId ?? '<manifest>'
    errors.push(...validateManifestShape(manifest, source))
    if (ids.has(manifest.workItemId)) errors.push(`${source}: workItemId 重复`)
    ids.add(manifest.workItemId)
  }
  if (errors.length > 0) return { errors, warnings, ordered: [], potentialConflicts: [] }

  for (const manifest of manifests) {
    const source = manifest.__source ?? manifest.workItemId
    try {
      verifyCommit(repo, manifest.baseSha, `${source}.baseSha`)
      verifyCommit(repo, manifest.headSha, `${source}.headSha`)
      if (gitResult(['merge-base', '--is-ancestor', manifest.baseSha, manifest.headSha], repo).status !== 0) {
        errors.push(`${source}: baseSha 不是 headSha 的祖先`)
      }
      const actual = normalizedFiles(git(['diff', '--name-only', `${manifest.baseSha}..${manifest.headSha}`], repo).split('\n').filter(Boolean))
      const declared = normalizedFiles(manifest.changedFiles)
      if (JSON.stringify(actual) !== JSON.stringify(declared)) {
        errors.push(`${source}: changedFiles 与真实 diff 不一致；declared=${JSON.stringify(declared)} actual=${JSON.stringify(actual)}`)
      }

      verifyCommit(repo, baseRef, 'baseRef')
      if (gitResult(['merge-base', '--is-ancestor', manifest.baseSha, baseRef], repo).status === 0) {
        const distance = Number(git(['rev-list', '--count', `${manifest.baseSha}..${baseRef}`], repo))
        if (distance > staleThreshold) warnings.push(`${manifest.workItemId}: 基线落后 ${baseRef} ${distance} 个提交（阈值 ${staleThreshold}）`)
      } else {
        // A stacked worker may legitimately branch from the exact implementation
        // head of a declared dependency. Accept only that cryptographically exact
        // edge: an undeclared sibling, an arbitrary descendant, or a dependency's
        // manifest commit must still fail closed as side-branch contamination.
        const stackedOn = dependenciesOf(manifest)
          .map((id) => manifestsById.get(id))
          .find((dependency) => dependency?.headSha === manifest.baseSha)
        if (!stackedOn) {
          errors.push(`${manifest.workItemId}: baseSha 不是 ${baseRef} 的祖先，也不等于已声明依赖的 headSha；禁止把旁支基线带入集成`)
        }
      }
    } catch (error) {
      errors.push(error.message)
    }
  }

  let ordered = []
  try {
    ordered = topologicalOrder(manifests)
  } catch (error) {
    errors.push(error.message)
  }
  const potentialConflicts = findPotentialConflicts(ordered)
  const positions = new Map(ordered.map((manifest, index) => [manifest.workItemId, index]))
  for (const conflict of potentialConflicts) {
    conflict.adjacent = Math.abs(positions.get(conflict.left) - positions.get(conflict.right)) === 1
  }
  return { errors, warnings, ordered, potentialConflicts }
}

function scanResultJson(directory, found = []) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && SCAN_SKIP.has(entry.name)) continue
    const absolute = path.join(directory, entry.name)
    if (entry.isDirectory()) scanResultJson(absolute, found)
    else if (entry.isFile() && entry.name === 'result.json') found.push(absolute)
  }
  return found
}

export function loadManifests(inputs) {
  const files = []
  for (const input of inputs) {
    const absolute = path.resolve(input)
    if (!fs.existsSync(absolute)) throw new Error(`manifest 路径不存在: ${input}`)
    if (fs.statSync(absolute).isDirectory()) files.push(...scanResultJson(absolute))
    else files.push(absolute)
  }
  if (files.length === 0) throw new Error('没有找到 result.json')
  return [...new Set(files)].sort().map((file) => ({ ...JSON.parse(fs.readFileSync(file, 'utf8')), __source: file }))
}

function sanitizeTrailer(value) {
  return String(value ?? 'n/a').replace(/[\r\n]+/g, ' ').trim() || 'n/a'
}

function runGate(gate, cwd) {
  if (FORBIDDEN_GATE.test(gate.command)) {
    return { ...gate, status: 'blocked', code: null, output: '门禁命令包含 push/deploy，已拒绝执行' }
  }
  const startedAt = new Date().toISOString()
  const result = spawnSync(gate.command, { cwd, encoding: 'utf8', shell: true, env: process.env })
  return {
    ...gate,
    status: result.status === 0 ? 'passed' : 'failed',
    code: result.status,
    startedAt,
    finishedAt: new Date().toISOString(),
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim().slice(-12000)
  }
}

function summarizeBlame(repo, ref, file) {
  const result = gitResult(['blame', '--line-porcelain', ref, '--', file], repo)
  if (result.status !== 0) return { ref, file, unavailable: (result.stderr || result.stdout).trim() }
  const counts = new Map()
  let commit = ''
  let author = ''
  for (const line of result.stdout.split('\n')) {
    if (/^[0-9a-f]{40} /.test(line)) commit = line.slice(0, 40)
    else if (line.startsWith('author ')) author = line.slice(7)
    else if (line.startsWith('\t')) {
      const key = `${commit.slice(0, 12)} ${author}`
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
  }
  return { ref, file, top: [...counts].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([source, lines]) => ({ source, lines })) }
}

function conflictDetails(repo, files) {
  return files.map((file) => ({
    file,
    current: summarizeBlame(repo, 'HEAD', file),
    incoming: summarizeBlame(repo, 'MERGE_HEAD', file)
  }))
}

function defaultReportPath(repo, runId) {
  const commonGit = path.resolve(repo, git(['rev-parse', '--git-common-dir'], repo))
  return path.join(commonGit, 'swob-workflow', 'reports', `${runId}.json`)
}

function writeReport(reportPath, report) {
  fs.mkdirSync(path.dirname(reportPath), { recursive: true })
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`)
}

export function assertSafeGates(gates) {
  const unsafe = gates.filter((gate) => FORBIDDEN_GATE.test(gate.command))
  if (unsafe.length > 0) throw new Error(`禁止的 push/deploy 门禁: ${unsafe.map((gate) => gate.id).join(', ')}`)
  return true
}

function parseArgs(argv) {
  const options = {
    manifests: [],
    baseRef: 'origin/master',
    staleThreshold: 20,
    dryRun: false,
    bootstrapGates: [],
    layerGates: [],
    fullGates: []
  }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--manifests') {
      while (argv[index + 1] && !argv[index + 1].startsWith('--')) options.manifests.push(argv[++index])
    } else if (argument === '--manifest-dir') options.manifests.push(argv[++index])
    else if (argument === '--base-ref') options.baseRef = argv[++index]
    else if (argument === '--stale-threshold') options.staleThreshold = Number(argv[++index])
    else if (argument === '--integration-dir') options.integrationDir = path.resolve(argv[++index])
    else if (argument === '--branch') options.branch = argv[++index]
    else if (argument === '--report') options.reportPath = path.resolve(argv[++index])
    else if (argument === '--dry-run') options.dryRun = true
    else throw new Error(`未知参数: ${argument}`)
  }
  if (options.manifests.length === 0) throw new Error('用 --manifests <result.json...> 或 --manifest-dir <dir> 提供清单')
  if (!Number.isInteger(options.staleThreshold) || options.staleThreshold < 0) throw new Error('--stale-threshold 必须是非负整数')
  if (options.branch && (!options.branch.startsWith('integration/') || options.branch.includes('..'))) {
    throw new Error('--branch 必须是 integration/* 专用分支')
  }
  if (options.bootstrapGates.length === 0) options.bootstrapGates = DEFAULT_BOOTSTRAP_GATES
  if (options.layerGates.length === 0) options.layerGates = DEFAULT_LAYER_GATES
  if (options.fullGates.length === 0) options.fullGates = DEFAULT_FULL_GATES
  assertSafeGates([...options.bootstrapGates, ...options.layerGates, ...options.fullGates])
  return options
}

export function runMergeQueue(options, repo = process.cwd()) {
  const bootstrapGates = options.bootstrapGates ?? DEFAULT_BOOTSTRAP_GATES
  const runId = `merge-queue-${new Date().toISOString().replace(/[:.]/g, '-')}`
  const reportPath = options.reportPath ?? defaultReportPath(repo, runId)
  const manifests = loadManifests(options.manifests)
  const preflight = preflightManifests(manifests, repo, options)
  const report = {
    schemaVersion: 1,
    runId,
    startedAt: new Date().toISOString(),
    repo: path.resolve(repo),
    baseRef: options.baseRef,
    staleThreshold: options.staleThreshold,
    preflight: {
      errors: preflight.errors,
      warnings: preflight.warnings,
      order: preflight.ordered.map((manifest) => manifest.workItemId),
      potentialConflicts: preflight.potentialConflicts
    },
    gatePlan: {
      bootstrap: bootstrapGates,
      layer: options.layerGates,
      full: options.fullGates,
      conflictScan: "git grep -n '^<<<<<<<' -- ."
    },
    items: preflight.ordered.map((manifest) => ({
      workItemId: manifest.workItemId,
      source: manifest.__source,
      baseSha: manifest.baseSha,
      headSha: manifest.headSha,
      changedFiles: manifest.changedFiles,
      tests: manifest.tests,
      depends_on: dependenciesOf(manifest),
      status: 'pending',
      bootstrapGates: [],
      gates: []
    })),
    fullGates: [],
    conflictScan: null,
    canPush: false,
    conclusion: preflight.errors.length > 0 ? '不可 push：预检失败' : '待集成'
  }
  if (preflight.errors.length > 0 || options.dryRun) {
    if (options.dryRun && preflight.errors.length === 0) report.conclusion = 'dry-run：预检通过，未创建集成 worktree'
    report.finishedAt = new Date().toISOString()
    writeReport(reportPath, report)
    return { report, reportPath, exitCode: preflight.errors.length > 0 ? 1 : 0 }
  }

  const temporaryParent = options.integrationDir ? null : fs.mkdtempSync(path.join(os.tmpdir(), 'swob-merge-queue-'))
  const integrationDir = options.integrationDir ?? path.join(temporaryParent, 'worktree')
  const branch = options.branch ?? `integration/${runId}`
  fs.mkdirSync(path.dirname(integrationDir), { recursive: true })
  if (fs.existsSync(integrationDir)) throw new Error(`集成 worktree 路径已存在: ${integrationDir}`)
  git(['worktree', 'add', '-b', branch, integrationDir, options.baseRef], repo)
  report.integration = { worktree: integrationDir, branch, retained: true }

  let dependenciesReady = false

  for (const [index, manifest] of preflight.ordered.entries()) {
    const item = report.items[index]
    const merge = gitResult(['merge', '--no-commit', '--no-ff', manifest.headSha], integrationDir)
    const unmerged = gitResult(['diff', '--name-only', '--diff-filter=U'], integrationDir).stdout.trim().split('\n').filter(Boolean)
    if (unmerged.length > 0) {
      item.status = 'paused-conflict'
      item.conflicts = conflictDetails(integrationDir, unmerged)
      item.mergeOutput = `${merge.stdout}${merge.stderr}`.trim()
      report.conclusion = '不可 push：合并冲突，等待 Integrator/人类处理'
      report.finishedAt = new Date().toISOString()
      writeReport(reportPath, report)
      return { report, reportPath, exitCode: 2 }
    }
    if (merge.status !== 0) {
      item.status = 'failed-merge'
      item.mergeOutput = `${merge.stdout}${merge.stderr}`.trim()
      report.conclusion = '不可 push：git merge 失败'
      report.finishedAt = new Date().toISOString()
      writeReport(reportPath, report)
      return { report, reportPath, exitCode: 2 }
    }

    if (!dependenciesReady || changesDependencyManifest(manifest)) {
      for (const gate of bootstrapGates) {
        const gateResult = runGate(gate, integrationDir)
        item.bootstrapGates.push(gateResult)
        if (gateResult.status !== 'passed') {
          item.status = 'paused-bootstrap'
          report.conclusion = `不可 push：${manifest.workItemId} 依赖引导失败`
          report.finishedAt = new Date().toISOString()
          writeReport(reportPath, report)
          return { report, reportPath, exitCode: 3 }
        }
      }
      dependenciesReady = true
    }

    for (const gate of options.layerGates) {
      const gateResult = runGate(gate, integrationDir)
      item.gates.push(gateResult)
      if (gateResult.status !== 'passed') {
        item.status = 'paused-gate'
        report.conclusion = `不可 push：${manifest.workItemId} 层门禁失败`
        report.finishedAt = new Date().toISOString()
        writeReport(reportPath, report)
        return { report, reportPath, exitCode: 3 }
      }
    }

    const mergeHead = gitResult(['rev-parse', '-q', '--verify', 'MERGE_HEAD'], integrationDir)
    if (mergeHead.status === 0) {
      const provenance = manifest.provenance ?? {}
      const message = [
        `merge(queue): integrate ${sanitizeTrailer(manifest.workItemId)}`,
        '',
        `Agent-Task: ${sanitizeTrailer(manifest.workItemId)}`,
        'Agent-Harness: merge-queue',
        'Agent-Model: deterministic-script',
        `Agent-Session: ${sanitizeTrailer(provenance.session)}`,
        `Agent-Decision: topo merge after ${[...item.bootstrapGates, ...item.gates].map((gate) => gate.id).join('+')} passed`,
        'Agent-Limitation: semantic conflict resolution intentionally disabled'
      ].join('\n')
      const commit = gitResult(['commit', '-m', message], integrationDir)
      if (commit.status !== 0) {
        item.status = 'failed-commit'
        item.commitOutput = `${commit.stdout}${commit.stderr}`.trim()
        report.conclusion = '不可 push：集成提交失败'
        report.finishedAt = new Date().toISOString()
        writeReport(reportPath, report)
        return { report, reportPath, exitCode: 3 }
      }
      item.integrationCommit = git(['rev-parse', 'HEAD'], integrationDir)
      item.status = 'integrated'
    } else {
      item.status = 'already-present'
    }
  }

  for (const gate of options.fullGates) {
    const gateResult = runGate(gate, integrationDir)
    report.fullGates.push(gateResult)
    if (gateResult.status !== 'passed') {
      report.conclusion = `不可 push：全量门禁 ${gate.id} 失败`
      report.finishedAt = new Date().toISOString()
      writeReport(reportPath, report)
      return { report, reportPath, exitCode: 4 }
    }
  }

  const conflictScan = gitResult(['grep', '-n', '^<<<<<<<', '--', '.'], integrationDir)
  report.conflictScan = {
    command: "git grep -n '^<<<<<<<' -- .",
    status: conflictScan.status === 1 ? 'passed' : 'failed',
    code: conflictScan.status,
    output: `${conflictScan.stdout}${conflictScan.stderr}`.trim()
  }
  if (report.conflictScan.status !== 'passed') {
    report.conclusion = '不可 push：仓库仍含冲突标记'
    report.finishedAt = new Date().toISOString()
    writeReport(reportPath, report)
    return { report, reportPath, exitCode: 4 }
  }

  report.canPush = true
  report.conclusion = '可 push（仅结论；脚本未执行 push/deploy）'
  report.finishedAt = new Date().toISOString()
  writeReport(reportPath, report)
  return { report, reportPath, exitCode: 0 }
}

function main() {
  try {
    const options = parseArgs(process.argv.slice(2))
    const result = runMergeQueue(options)
    process.stdout.write(`${JSON.stringify({ report: result.reportPath, conclusion: result.report.conclusion }, null, 2)}\n`)
    process.exitCode = result.exitCode
  } catch (error) {
    process.stderr.write(`merge-queue: ${error.message}\n`)
    process.exitCode = 1
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
