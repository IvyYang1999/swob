#!/usr/bin/env node

import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const documentPath = path.join(repoRoot, 'src', 'main', 'pricing-snapshots.json')
const document = JSON.parse(fs.readFileSync(documentPath, 'utf8'))
const requiredRoles = ['history-formula', 'coverage-diff', 'model-identity', 'official-review-override']

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

function finiteNonNegative(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be a finite non-negative number`)
  }
}

function dimensionsKey(dimensions) {
  return JSON.stringify(stableJson({
    serviceTier: dimensions?.serviceTier?.toLowerCase() || 'standard',
    speed: dimensions?.speed?.toLowerCase() || 'standard',
    batchMode: dimensions?.batchMode || 'realtime',
    region: dimensions?.region?.toLowerCase() || null
  }))
}

if (document.schemaVersion !== 1 || !Array.isArray(document.baseRules) || !Array.isArray(document.snapshots)) {
  throw new Error('pricing-snapshots.json must use schemaVersion 1 with baseRules and snapshots')
}

let rules = new Map(document.baseRules.map((rule) => [rule.id, rule]))
let unitRules
const resolved = new Map()
for (const snapshot of document.snapshots) {
  if (snapshot.status !== 'approved') throw new Error(`${snapshot.revision} is not approved`)
  if (snapshot.replaces) {
    const previous = resolved.get(snapshot.replaces)
    if (!previous) throw new Error(`${snapshot.revision} replaces unknown ${snapshot.replaces}`)
    rules = new Map(previous.rules.map((rule) => [rule.id, rule]))
    unitRules = previous.unitRules
  }
  if (snapshot.sourcePipeline.map((source) => source.role).join('\0') !== requiredRoles.join('\0')) {
    throw new Error(`${snapshot.revision} source pipeline is incomplete or out of order`)
  }
  for (const source of snapshot.sourcePipeline) {
    if (!source.revision || !source.evidenceUrl) throw new Error(`${snapshot.revision} has unpinned source evidence`)
  }
  for (const patch of snapshot.patches) {
    if (patch.op === 'replace') {
      if (!rules.delete(patch.ruleId)) throw new Error(`${snapshot.revision} replaces missing ${patch.ruleId}`)
    }
    if (rules.has(patch.rule.id)) throw new Error(`${snapshot.revision} duplicates ${patch.rule.id}`)
    rules.set(patch.rule.id, patch.rule)
  }
  const ruleList = [...rules.values()]
  for (const rule of ruleList) {
    finiteNonNegative(rule.usdPerMillion.input, `${rule.id}.input`)
    finiteNonNegative(rule.usdPerMillion.output, `${rule.id}.output`)
    if (new Date(rule.effectiveFrom).toString() === 'Invalid Date') throw new Error(`${rule.id} has invalid effectiveFrom`)
    if (rule.effectiveTo && new Date(rule.effectiveTo) <= new Date(rule.effectiveFrom)) {
      throw new Error(`${rule.id} has a non-positive effective interval`)
    }
  }
  const byModel = new Map()
  for (const rule of ruleList) {
    const key = `${rule.provider}\0${rule.modelCanonical}\0${dimensionsKey(rule.dimensions)}`
    const values = byModel.get(key) || []
    values.push(rule)
    byModel.set(key, values)
  }
  if (snapshot.unitRules) unitRules = snapshot.unitRules
  for (const rule of unitRules || []) {
    finiteNonNegative(rule.usdPerUnit, `${rule.id}.usdPerUnit`)
    if (rule.reviewStatus !== 'approved') throw new Error(`${rule.id} is not approved`)
  }
  const byUnit = new Map()
  for (const rule of unitRules || []) {
    const key = `${rule.provider}\0${rule.sku}\0${rule.unit}\0${dimensionsKey(rule.dimensions)}`
    const values = byUnit.get(key) || []
    values.push(rule)
    byUnit.set(key, values)
  }
  for (const [key, modelRules] of byModel) {
    modelRules.sort((left, right) => Date.parse(left.effectiveFrom) - Date.parse(right.effectiveFrom))
    for (let index = 1; index < modelRules.length; index++) {
      const previousTo = modelRules[index - 1].effectiveTo
        ? Date.parse(modelRules[index - 1].effectiveTo)
        : Number.POSITIVE_INFINITY
      if (previousTo > Date.parse(modelRules[index].effectiveFrom)) {
        throw new Error(`${snapshot.revision} has overlapping rules for ${key}`)
      }
    }
  }
  for (const [key, pricedUnits] of byUnit) {
    pricedUnits.sort((left, right) => Date.parse(left.effectiveFrom) - Date.parse(right.effectiveFrom))
    for (let index = 1; index < pricedUnits.length; index++) {
      const previousTo = pricedUnits[index - 1].effectiveTo
        ? Date.parse(pricedUnits[index - 1].effectiveTo)
        : Number.POSITIVE_INFINITY
      if (previousTo > Date.parse(pricedUnits[index].effectiveFrom)) {
        throw new Error(`${snapshot.revision} has overlapping unit rules for ${key}`)
      }
    }
  }
  const payload = {
    schemaVersion: document.schemaVersion,
    revision: snapshot.revision,
    status: snapshot.status,
    generatedAt: snapshot.generatedAt,
    reviewedAt: snapshot.reviewedAt,
    ...(snapshot.replaces ? { replaces: snapshot.replaces } : {}),
    ...(snapshot.revisionReason ? { revisionReason: snapshot.revisionReason } : {}),
    ...(snapshot.revisionNotice ? { revisionNotice: snapshot.revisionNotice } : {}),
    sourcePipeline: snapshot.sourcePipeline,
    rules: ruleList,
    ...(unitRules ? { unitRules } : {})
  }
  const observedHash = digest(payload)
  if (observedHash !== snapshot.contentHash) {
    throw new Error(`${snapshot.revision} hash mismatch: expected ${snapshot.contentHash}, got ${observedHash}`)
  }
  resolved.set(snapshot.revision, { rules: ruleList, unitRules })
}

const active = document.snapshots.at(-1)
if (!active?.revision || !active.replaces) throw new Error('active snapshot must be an approved successor')
console.log(`Verified ${document.snapshots.length} immutable price snapshots; active=${active.revision} hash=${active.contentHash}`)
