#!/usr/bin/env node

import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const candidate = JSON.parse(fs.readFileSync(path.join(repoRoot, 'pricing', 'candidates', 'pending-review.json'), 'utf8'))
const drift = JSON.parse(fs.readFileSync(path.join(repoRoot, 'pricing', 'candidates', 'drift-report.json'), 'utf8'))
const coverage = JSON.parse(fs.readFileSync(path.join(repoRoot, 'pricing', 'candidates', 'coverage-report.json'), 'utf8'))
const runtime = JSON.parse(fs.readFileSync(path.join(repoRoot, 'src', 'main', 'pricing-snapshots.json'), 'utf8'))

function stableJson(value) {
  if (Array.isArray(value)) return value.map(stableJson)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => [key, stableJson(item)]))
}

function digest(value) {
  return createHash('sha256').update(JSON.stringify(stableJson(value))).digest('hex')
}

function fail(message) {
  throw new Error(message)
}

function dimensionKey(rule) {
  return JSON.stringify(stableJson({
    serviceTier: rule.dimensions?.serviceTier?.toLowerCase() || 'standard',
    speed: rule.dimensions?.speed?.toLowerCase() || 'standard',
    batchMode: rule.dimensions?.batchMode || 'realtime',
    region: rule.dimensions?.region?.toLowerCase() || null
  }))
}

if (candidate.status !== 'pending-review' || candidate.review?.activationAllowed !== false) {
  fail('candidate must stay pending-review with activationAllowed=false')
}
if (runtime.snapshots.some((snapshot) => snapshot.status !== 'approved' || snapshot.revision === candidate.revision)) {
  fail('pending candidate leaked into the runtime snapshot document')
}
const expectedRoles = ['history-formula', 'coverage-diff', 'model-identity', 'official-review-override']
if (candidate.sourcePipeline.map((source) => source.role).join('\0') !== expectedRoles.join('\0')) {
  fail('candidate source pipeline is incomplete or out of order')
}
for (const source of candidate.sourcePipeline) {
  if (!source.revision || !source.evidenceUrl) fail(`candidate source ${source.name} is not pinned`)
}
for (const rule of candidate.rules) {
  if (rule.reviewStatus !== 'pending-review' || !rule.sourceRevision || !rule.sourceUrl || !rule.officialReviewUrl) {
    fail(`${rule.id} lacks pending-review evidence`)
  }
  for (const [component, value] of Object.entries(rule.usdPerMillion)) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) fail(`${rule.id}.${component} is invalid`)
  }
}
const histories = new Map()
for (const rule of candidate.rules) {
  const key = `${rule.provider}\0${rule.modelCanonical}\0${dimensionKey(rule)}`
  const values = histories.get(key) || []
  values.push(rule)
  histories.set(key, values)
}
for (const [key, rules] of histories) {
  rules.sort((left, right) => Date.parse(left.effectiveFrom) - Date.parse(right.effectiveFrom))
  for (let index = 1; index < rules.length; index++) {
    const priorEnd = rules[index - 1].effectiveTo
      ? Date.parse(rules[index - 1].effectiveTo)
      : Number.POSITIVE_INFINITY
    if (priorEnd > Date.parse(rules[index].effectiveFrom)) fail(`overlapping candidate rules for ${key}`)
  }
}
for (const rule of candidate.unitRules) {
  if (rule.reviewStatus !== 'pending-review' || rule.source !== 'official' || !rule.sourceRevision || !rule.sourceUrl) {
    fail(`${rule.id} is not an official pending-review unit rule`)
  }
  if (!Number.isFinite(rule.usdPerUnit) || rule.usdPerUnit < 0) fail(`${rule.id}.usdPerUnit is invalid`)
}
const providers = new Set(candidate.rules.map((rule) => rule.provider))
for (const required of ['anthropic', 'openai', 'google', 'xai', 'moonshot', 'deepseek', 'alibaba', 'mistral']) {
  if (!providers.has(required)) fail(`candidate is missing provider ${required}`)
}
for (const unit of ['search', 'image', 'audio-minute', 'gigabyte-day']) {
  if (!candidate.unitRules.some((rule) => rule.unit === unit)) fail(`candidate is missing official unit ${unit}`)
}
if (!candidate.rules.some((rule) => rule.dimensions?.batchMode === 'batch') ||
  !candidate.rules.some((rule) => rule.dimensions?.speed === 'fast')) {
  fail('candidate is missing reviewed modifier dimensions')
}
if (candidate.rules.some((rule) => rule.dimensions && !rule.pricingFormula)) {
  fail('candidate modifier rule is missing its formula')
}
const payload = {
  schemaVersion: 2,
  revision: candidate.revision,
  status: candidate.status,
  generatedAt: candidate.generatedAt,
  sourcePipeline: candidate.sourcePipeline,
  rules: candidate.rules.map(({ catalogVersion: _catalogVersion, ...rule }) => rule),
  unitRules: candidate.unitRules,
  review: candidate.review
}
if (digest(payload) !== candidate.contentHash) fail('candidate content hash mismatch')
if (drift.activation !== 'blocked-pending-review' || drift.candidateHash !== candidate.contentHash) {
  fail('drift report is not bound to the blocked candidate')
}
if (coverage.mode !== 'explicit-candidate-what-if' || coverage.activation !== 'blocked-pending-review' ||
  coverage.candidateHash !== candidate.contentHash || coverage.libraryPackages < 1_800 ||
  coverage.improvementPercentagePoints < 5 || coverage.after.unpricedPercent >= coverage.before.unpricedPercent) {
  fail('real-library coverage evidence is missing, stale, or not significant')
}
for (const source of candidate.sourcePipeline.slice(0, 3)) {
  const driftRevision = drift.sourceRevisions[source.name === 'genai-prices'
    ? 'genaiPrices'
    : source.name === 'LiteLLM' ? 'liteLlm' : 'modelsDev']
  if (driftRevision !== source.revision) fail(`drift report revision mismatch for ${source.name}`)
}

console.log(`Verified isolated ${candidate.revision}: ${candidate.rules.length} token rules, ${candidate.unitRules.length} unit rules, hash=${candidate.contentHash}`)
