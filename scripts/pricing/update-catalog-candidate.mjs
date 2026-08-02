#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import yaml from 'js-yaml'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const TARGETS = [
  { upstream: 'anthropic', provider: 'anthropic', file: 'anthropic.yml', official: 'https://platform.claude.com/docs/en/about-claude/pricing' },
  { upstream: 'openai', provider: 'openai', file: 'openai.yml', official: 'https://developers.openai.com/api/docs/pricing' },
  { upstream: 'google', provider: 'google', file: 'google.yml', official: 'https://ai.google.dev/gemini-api/docs/pricing' },
  { upstream: 'x-ai', provider: 'xai', file: 'x_ai.yml', official: 'https://docs.x.ai/developers/pricing' },
  { upstream: 'moonshotai', provider: 'moonshot', file: 'moonshotai.yml', official: 'https://platform.moonshot.ai/docs/pricing/chat#product-pricing' },
  { upstream: 'deepseek', provider: 'deepseek', file: 'deepseek.yml', official: 'https://api-docs.deepseek.com/quick_start/pricing/' },
  { upstream: 'mistral', provider: 'mistral', file: 'mistral.yml', official: 'https://mistral.ai/pricing/api/' }
]
const ALIBABA_OFFICIAL = 'https://help.aliyun.com/zh/model-studio/model-pricing'

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

function git(repo, args) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim()
}

function isoDate(value) {
  return new Date(value).toISOString()
}

function numberBase(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (value && typeof value === 'object' && typeof value.base === 'number') return value.base
  return undefined
}

function applicablePrices(model, at) {
  if (!Array.isArray(model.prices)) return model.prices
  const timestamp = Date.parse(at)
  return model.prices
    .filter((entry) => {
      const start = entry.constraint?.start_date ? Date.parse(entry.constraint.start_date) : Number.NEGATIVE_INFINITY
      const end = entry.constraint?.end_date ? Date.parse(entry.constraint.end_date) : Number.POSITIVE_INFINITY
      return timestamp >= start && timestamp < end
    })
    .at(-1)?.prices
}

function tokenPrice(prices) {
  if (!prices || typeof prices !== 'object') return undefined
  const input = numberBase(prices.input_mtok)
  const output = numberBase(prices.output_mtok)
  if (input === undefined || output === undefined) return undefined
  const result = {
    input,
    output,
    ...(numberBase(prices.cache_read_mtok) !== undefined ? { cacheRead: numberBase(prices.cache_read_mtok) } : {}),
    ...(numberBase(prices.cache_write_mtok) !== undefined ? { cacheWrite: numberBase(prices.cache_write_mtok) } : {}),
    ...(numberBase(prices.cache_write_5m_mtok) !== undefined ? { cacheWrite5m: numberBase(prices.cache_write_5m_mtok) } : {}),
    ...(numberBase(prices.cache_write_1h_mtok) !== undefined ? { cacheWrite1h: numberBase(prices.cache_write_1h_mtok) } : {})
  }
  const inputTier = prices.input_mtok?.tiers?.[0]
  const outputTier = prices.output_mtok?.tiers?.[0]
  const context = inputTier?.start
  return {
    usdPerMillion: result,
    ...(typeof context === 'number' && typeof inputTier.price === 'number' && typeof outputTier?.price === 'number'
      ? {
          contextThresholdTokens: context,
          thresholdMode: 'whole-request',
          longContextMultiplier: { input: inputTier.price / input, output: outputTier.price / output }
        }
      : {})
  }
}

function modelMatchers(model) {
  const values = [{ kind: 'equals', value: String(model.id).toLowerCase() }]
  const visit = (clause) => {
    if (!clause || typeof clause !== 'object') return
    if (Array.isArray(clause)) {
      for (const item of clause) visit(item)
      return
    }
    for (const [key, value] of Object.entries(clause)) {
      if (key === 'equals' && typeof value === 'string') values.push({ kind: 'equals', value: value.toLowerCase() })
      else if (key === 'starts_with' && typeof value === 'string') values.push({ kind: 'starts-with', value: value.toLowerCase() })
      else if (key === 'contains' && typeof value === 'string') values.push({ kind: 'contains', value: value.toLowerCase() })
      else if (key !== 'regex') visit(value)
    }
  }
  visit(model.match)
  return [...new Map(values.map((item) => [`${item.kind}\0${item.value}`, item])).values()]
}

function historyForTarget(genaiRepo, target, generatedAt, revision) {
  const sourceFile = `prices/providers/${target.file}`
  const current = yaml.load(fs.readFileSync(path.join(genaiRepo, sourceFile), 'utf8'))
  // Preserve retired models for historical what-if while also including every current model.
  const catalogIds = new Set((current.models || []).map((model) => model.id))
  const commits = git(genaiRepo, ['log', '--reverse', '--format=%H\t%aI', '--', sourceFile])
    .split('\n').filter(Boolean).map((line) => {
      const [sha, committedAt] = line.split('\t')
      return { sha, committedAt: isoDate(committedAt) }
    })
  const histories = new Map()
  for (const commit of commits) {
    const document = yaml.load(git(genaiRepo, ['show', `${commit.sha}:${sourceFile}`]))
    for (const model of document.models || []) {
      if (!catalogIds.has(model.id)) continue
      const price = tokenPrice(applicablePrices(model, commit.committedAt))
      if (!price) continue
      const normalized = { ...price, modelMatchers: modelMatchers(model) }
      const signature = digest(normalized)
      const prior = histories.get(model.id) || []
      if (prior.at(-1)?.signature !== signature) prior.push({ ...commit, signature, normalized })
      histories.set(model.id, prior)
    }
  }
  const rules = []
  for (const [modelCanonical, segments] of histories) {
    for (let index = 0; index < segments.length; index++) {
      const segment = segments[index]
      rules.push({
        id: `${target.provider}:${modelCanonical}:${segment.committedAt}`,
        provider: target.provider,
        modelCanonical,
        effectiveFrom: segment.committedAt,
        ...(segments[index + 1] ? { effectiveTo: segments[index + 1].committedAt } : {}),
        ...segment.normalized,
        source: 'genai-prices',
        sourceUrl: `https://github.com/pydantic/genai-prices/blob/${segment.sha}/${sourceFile}`,
        sourceRevision: segment.sha,
        officialReviewUrl: target.official,
        reviewStatus: 'pending-review',
        catalogVersion: revision
      })
    }
  }
  return rules.filter((rule) => Date.parse(rule.effectiveFrom) <= Date.parse(generatedAt))
}

function litellmProvider(entryKey, value) {
  const provider = String(value.litellm_provider || '').toLowerCase()
  if (provider === 'xai') return 'xai'
  if (provider === 'gemini' || provider === 'vertex_ai') return 'google'
  if (provider === 'moonshot') return 'moonshot'
  if (provider === 'dashscope') return 'alibaba'
  if (['anthropic', 'openai', 'deepseek', 'mistral'].includes(provider)) return provider
  if (entryKey.startsWith('dashscope/')) return 'alibaba'
  return undefined
}

function litellmModelId(entryKey, provider) {
  if (provider === 'alibaba' && entryKey.startsWith('dashscope/')) return entryKey.slice('dashscope/'.length)
  const segments = entryKey.split('/')
  return segments.length === 2 ? segments[1] : entryKey
}

function liteLlmDiff(litellmDocument, candidateRules, revision, generatedAt) {
  const known = new Map(candidateRules.map((rule) => [`${rule.provider}\0${rule.modelCanonical}`, rule]))
  const onlyInLiteLlm = []
  const priceDisagreements = []
  const alibabaRules = []
  for (const [entryKey, value] of Object.entries(litellmDocument)) {
    const provider = litellmProvider(entryKey, value)
    if (!provider) continue
    const modelCanonical = litellmModelId(entryKey, provider)
    const input = Number(value.input_cost_per_token) * 1_000_000
    const output = Number(value.output_cost_per_token) * 1_000_000
    if (!Number.isFinite(input) || !Number.isFinite(output)) continue
    const existing = known.get(`${provider}\0${modelCanonical}`)
    if (!existing) {
      onlyInLiteLlm.push({ provider, modelCanonical, entryKey })
      if (provider === 'alibaba') {
        alibabaRules.push({
          id: `alibaba:${modelCanonical}:${generatedAt}:litellm-candidate`,
          provider,
          modelCanonical,
          modelMatchers: [{ kind: 'equals', value: modelCanonical.toLowerCase() }],
          effectiveFrom: generatedAt,
          usdPerMillion: {
            input,
            output,
            ...(Number.isFinite(Number(value.cache_read_input_token_cost))
              ? { cacheRead: Number(value.cache_read_input_token_cost) * 1_000_000 }
              : {})
          },
          source: 'litellm',
          sourceUrl: `https://github.com/BerriAI/litellm/blob/${revision}/model_prices_and_context_window.json`,
          sourceRevision: revision,
          officialReviewUrl: ALIBABA_OFFICIAL,
          reviewStatus: 'pending-review',
          catalogVersion: `candidate-${generatedAt.slice(0, 10)}`
        })
      }
    } else if (Math.abs(existing.usdPerMillion.input - input) > 1e-9 ||
      Math.abs(existing.usdPerMillion.output - output) > 1e-9) {
      priceDisagreements.push({
        provider,
        modelCanonical,
        genai: existing.usdPerMillion,
        litellm: { input, output },
        disposition: 'pending-official-review'
      })
    }
  }
  return {
    alibabaRules,
    drift: {
      generatedAt,
      activation: 'blocked-pending-review',
      onlyInLiteLlm: onlyInLiteLlm.sort((a, b) => `${a.provider}/${a.modelCanonical}`.localeCompare(`${b.provider}/${b.modelCanonical}`)),
      priceDisagreements: priceDisagreements.sort((a, b) => `${a.provider}/${a.modelCanonical}`.localeCompare(`${b.provider}/${b.modelCanonical}`))
    }
  }
}

function scaleRule(rule, idSuffix, dimensions, multiplier) {
  return {
    ...rule,
    id: `${rule.id}:${idSuffix}`,
    dimensions,
    pricingFormula: `base * ${multiplier}`,
    usdPerMillion: Object.fromEntries(Object.entries(rule.usdPerMillion).map(([key, value]) => [key, value * multiplier]))
  }
}

function modifierRules(rules, generatedAt) {
  const latest = new Map()
  for (const rule of rules.filter((item) => !item.effectiveTo)) latest.set(`${rule.provider}\0${rule.modelCanonical}`, rule)
  const modifiers = []
  for (const rule of latest.values()) {
    const current = { ...rule, effectiveFrom: generatedAt, effectiveTo: undefined }
    if (rule.provider === 'anthropic' || rule.provider === 'openai') {
      modifiers.push(scaleRule(current, 'batch', { batchMode: 'batch' }, 0.5))
    }
    if (rule.provider === 'anthropic' && ['claude-opus-4-6', 'claude-opus-4-7'].includes(rule.modelCanonical)) {
      modifiers.push(scaleRule(current, 'fast', { speed: 'fast' }, 6))
    }
  }
  return modifiers
}

function officialUnitRules(generatedAt) {
  const pending = { source: 'official', sourceRevision: `official-review-${generatedAt.slice(0, 10)}`, reviewStatus: 'pending-review' }
  return [
    {
      id: `anthropic:web-search:${generatedAt}`, provider: 'anthropic', sku: 'web-search', unit: 'search',
      usdPerUnit: 0.01, effectiveFrom: generatedAt, ...pending,
      sourceUrl: 'https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool'
    },
    {
      id: `openai:dall-e-3-standard-1024:${generatedAt}`, provider: 'openai',
      sku: 'dall-e-3-standard-1024', unit: 'image', usdPerUnit: 0.04, effectiveFrom: generatedAt, ...pending,
      sourceUrl: 'https://developers.openai.com/api/docs/models/dall-e-3'
    },
    {
      id: `openai:whisper-1:${generatedAt}`, provider: 'openai', sku: 'whisper-1', unit: 'audio-minute',
      usdPerUnit: 0.006, effectiveFrom: generatedAt, ...pending,
      sourceUrl: 'https://developers.openai.com/api/docs/models/whisper-1'
    },
    {
      id: `openai:file-search-storage:${generatedAt}`, provider: 'openai', sku: 'file-search-storage',
      unit: 'gigabyte-day', usdPerUnit: 0.1, effectiveFrom: generatedAt, ...pending,
      sourceUrl: 'https://developers.openai.com/api/docs/pricing'
    }
  ]
}

export function buildCandidate({ genaiRepo, litellmRepo, generatedAt, modelsDevRevision }) {
  const genaiRevision = git(genaiRepo, ['rev-parse', 'HEAD'])
  const litellmRevision = git(litellmRepo, ['rev-parse', 'HEAD'])
  const revision = `candidate-${generatedAt.slice(0, 10)}.v1`
  const tokenRules = TARGETS.flatMap((target) => historyForTarget(genaiRepo, target, generatedAt, revision))
  const litellmDocument = JSON.parse(fs.readFileSync(path.join(litellmRepo, 'model_prices_and_context_window.json'), 'utf8'))
  const { alibabaRules, drift } = liteLlmDiff(litellmDocument, tokenRules, litellmRevision, generatedAt)
  const rules = [...tokenRules, ...alibabaRules, ...modifierRules(tokenRules, generatedAt)]
    .sort((a, b) => a.id.localeCompare(b.id))
  const candidate = {
    revision,
    status: 'pending-review',
    generatedAt,
    contentHash: '',
    sourcePipeline: [
      { name: 'genai-prices', role: 'history-formula', revision: genaiRevision, evidenceUrl: `https://github.com/pydantic/genai-prices/tree/${genaiRevision}` },
      { name: 'LiteLLM', role: 'coverage-diff', revision: litellmRevision, evidenceUrl: `https://github.com/BerriAI/litellm/tree/${litellmRevision}` },
      { name: 'models.dev', role: 'model-identity', revision: modelsDevRevision, evidenceUrl: `https://github.com/anomalyco/models.dev/tree/${modelsDevRevision}` },
      { name: 'Swob official review', role: 'official-review-override', revision: 'pending-yyt-signoff', evidenceUrl: 'https://developers.openai.com/api/docs/pricing' }
    ],
    rules,
    unitRules: officialUnitRules(generatedAt),
    review: { requiredApprover: 'yyt/负责人', activationAllowed: false }
  }
  candidate.contentHash = digest({
    schemaVersion: 2,
    revision: candidate.revision,
    status: candidate.status,
    generatedAt: candidate.generatedAt,
    sourcePipeline: candidate.sourcePipeline,
    rules: candidate.rules.map(({ catalogVersion: _catalogVersion, ...rule }) => rule),
    unitRules: candidate.unitRules,
    review: candidate.review
  })
  return {
    candidate,
    drift: {
      ...drift,
      sourceRevisions: { genaiPrices: genaiRevision, liteLlm: litellmRevision, modelsDev: modelsDevRevision },
      candidateRevision: candidate.revision,
      candidateHash: candidate.contentHash,
      counts: {
        tokenRules: candidate.rules.length,
        unitRules: candidate.unitRules.length,
        providers: [...new Set(candidate.rules.map((rule) => rule.provider))].sort()
      }
    }
  }
}

function args(argv) {
  const result = {}
  for (let index = 0; index < argv.length; index += 2) result[argv[index]?.replace(/^--/, '')] = argv[index + 1]
  return result
}

function main() {
  const options = args(process.argv.slice(2))
  if (!options.genai || !options.litellm) {
    throw new Error('Usage: update-catalog-candidate.mjs --genai <repo> --litellm <repo> [--at ISO] [--models-dev-revision SHA]')
  }
  const generatedAt = isoDate(options.at || new Date())
  const modelsDevRevision = options['models-dev-revision'] || '8d8f4dcdfb121983c84941540bba0c856e54f9fa'
  const outputDir = path.join(repoRoot, 'pricing', 'candidates')
  fs.mkdirSync(outputDir, { recursive: true })
  const { candidate, drift } = buildCandidate({
    genaiRepo: path.resolve(options.genai),
    litellmRepo: path.resolve(options.litellm),
    generatedAt,
    modelsDevRevision
  })
  fs.writeFileSync(path.join(outputDir, 'pending-review.json'), `${JSON.stringify(candidate, null, 2)}\n`)
  fs.writeFileSync(path.join(outputDir, 'drift-report.json'), `${JSON.stringify(drift, null, 2)}\n`)
  process.stdout.write(`Generated ${candidate.revision}: ${candidate.rules.length} token rules, ${candidate.unitRules.length} unit rules; activation blocked pending review.\n`)
}

if (path.resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) main()
