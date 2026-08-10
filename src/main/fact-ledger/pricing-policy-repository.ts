import Database from 'better-sqlite3'
import type {
  Availability, PricingPolicyMutationCommand, PricingPolicyMutationResponse, UserModelAlias,
  UserPricingPolicy, UsageAttribution, ValuationView
} from '../../shared/contracts/truth-kernel'

export interface AliasMutationResponse {
  status: 'applied' | 'conflict' | 'invalid'
  reason: string
}

export interface OfficialPriceSnapshot {
  snapshotId: string
  revision: string
  digest: string
  providerId: string
  modelId: string
  currency: string
  rates: UserPricingPolicy['rates']
}

export interface PricingPolicyRepository {
  apply(command: PricingPolicyMutationCommand): PricingPolicyMutationResponse
  list(): readonly UserPricingPolicy[]
  resolve(providerId: string, modelId: string, purpose: UserPricingPolicy['purpose'], at: string): UserPricingPolicy | { status: 'ambiguous' | 'unavailable'; reason: string }
  resolveAlias(providerId: string, rawModelId: string, at: string): UserModelAlias | { status: 'ambiguous' | 'unavailable'; reason: string }
  addAlias(alias: UserModelAlias): AliasMutationResponse
  close(): void
}

const unavailable = <T>(reason: string): Availability<T> => ({ status: 'unavailable', reason })

function response(commandId: string, status: PricingPolicyMutationResponse['status'], reason: string, revision?: UserPricingPolicy): PricingPolicyMutationResponse {
  return {
    contractVersion: '1.0.0', commandId, status,
    appendedRevisionId: revision ? { status: 'available', value: revision.revisionId } : unavailable(reason),
    headRevision: revision ? { status: 'available', value: revision.revision } : unavailable(reason),
    errorCode: status === 'applied' ? unavailable('none') : { status: 'available', value: reason }
  }
}

function validTimestamp(value: string): boolean {
  return value.length > 0 && Number.isFinite(Date.parse(value))
}

function validatePolicy(policy: UserPricingPolicy): string | undefined {
  if (!policy.policyId || !policy.revisionId || !policy.policyVersion || !policy.providerId || !policy.modelId || !policy.modelPattern || !policy.sourceNote) return 'required-field-empty'
  if (policy.purpose !== 'public-price-correction' && policy.purpose !== 'contract-price') return 'invalid-policy-purpose'
  if (!/^[A-Z]{3}$/.test(policy.currency)) return 'invalid-currency'
  if (!Number.isInteger(policy.revision) || policy.revision < 1) return 'invalid-revision'
  if (policy.lifecycle !== 'active') return 'submitted-revision-must-be-active'
  if (!validTimestamp(policy.effectiveFrom) || !validTimestamp(policy.createdAt) || !validTimestamp(policy.updatedAt)) return 'invalid-timestamp'
  if (policy.effectiveUntil.status === 'available' && (!validTimestamp(policy.effectiveUntil.value) || Date.parse(policy.effectiveUntil.value) <= Date.parse(policy.effectiveFrom))) return 'invalid-effective-interval'
  if (policy.rates.length === 0 || policy.rates.some((rate) => !Number.isFinite(rate.price) || rate.price <= 0 || !Number.isFinite(rate.unitSize) || rate.unitSize <= 0)) return 'invalid-rate'
  return undefined
}

function inInterval(from: string, until: Availability<string>, at: string): boolean {
  const instant = Date.parse(at)
  return Number.isFinite(instant) && Date.parse(from) <= instant && (until.status !== 'available' || instant < Date.parse(until.value))
}

function patternMatches(pattern: string, modelId: string): boolean {
  return pattern.endsWith('*') ? modelId.startsWith(pattern.slice(0, -1)) : pattern === modelId
}

/** Opens the versioned repository. Use a filesystem path for durable production storage; :memory: is test-only. */
export function openPricingPolicyRepository(databasePath: string, seed: readonly UserPricingPolicy[] = [], aliases: readonly UserModelAlias[] = []): PricingPolicyRepository {
  const database = new Database(databasePath)
  database.pragma('journal_mode = WAL')
  database.pragma('synchronous = FULL')
  database.exec(`
    CREATE TABLE IF NOT EXISTS user_pricing_policy_revisions (
      revision_id TEXT PRIMARY KEY,
      policy_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      policy_json TEXT NOT NULL,
      UNIQUE(policy_id, revision)
    );
    CREATE TABLE IF NOT EXISTS user_model_aliases (
      alias_id TEXT PRIMARY KEY,
      alias_json TEXT NOT NULL
    );
  `)
  const insertPolicy = database.prepare('INSERT INTO user_pricing_policy_revisions(revision_id, policy_id, revision, policy_json) VALUES (?, ?, ?, ?)')
  const insertAlias = database.prepare('INSERT INTO user_model_aliases(alias_id, alias_json) VALUES (?, ?)')
  const policies = (): UserPricingPolicy[] => (database.prepare('SELECT policy_json FROM user_pricing_policy_revisions ORDER BY policy_id, revision').all() as Array<{ policy_json: string }>).map((row) => JSON.parse(row.policy_json) as UserPricingPolicy)
  const modelAliases = (): UserModelAlias[] => (database.prepare('SELECT alias_json FROM user_model_aliases ORDER BY alias_id').all() as Array<{ alias_json: string }>).map((row) => JSON.parse(row.alias_json) as UserModelAlias)
  const head = (policyId: string): UserPricingPolicy | undefined => policies().filter((policy) => policy.policyId === policyId).at(-1)
  const addAlias = (alias: UserModelAlias): AliasMutationResponse => {
    if (!alias.aliasId || !alias.providerId || !alias.rawModelId || !alias.canonicalModelId || !alias.aliasVersion || !validTimestamp(alias.effectiveFrom)) return { status: 'invalid', reason: 'invalid-alias' }
    if (alias.effectiveUntil.status === 'available' && (!validTimestamp(alias.effectiveUntil.value) || Date.parse(alias.effectiveUntil.value) <= Date.parse(alias.effectiveFrom))) return { status: 'invalid', reason: 'invalid-effective-interval' }
    const overlaps = modelAliases().some((current) => current.providerId === alias.providerId && current.rawModelId === alias.rawModelId &&
      Date.parse(current.effectiveFrom) < (alias.effectiveUntil.status === 'available' ? Date.parse(alias.effectiveUntil.value) : Number.POSITIVE_INFINITY) &&
      Date.parse(alias.effectiveFrom) < (current.effectiveUntil.status === 'available' ? Date.parse(current.effectiveUntil.value) : Number.POSITIVE_INFINITY))
    if (overlaps) return { status: 'conflict', reason: 'overlapping-exact-model-aliases' }
    try { insertAlias.run(alias.aliasId, JSON.stringify(alias)) } catch { return { status: 'conflict', reason: 'alias-id-conflict' } }
    return { status: 'applied', reason: 'none' }
  }
  database.transaction(() => {
    for (const policy of seed) if (!head(policy.policyId)) insertPolicy.run(policy.revisionId, policy.policyId, policy.revision, JSON.stringify(policy))
    for (const alias of aliases) if (!modelAliases().some((row) => row.aliasId === alias.aliasId)) addAlias(alias)
  })()
  return {
    list: policies,
    addAlias,
    resolveAlias(providerId, rawModelId, at) {
      const matches = modelAliases().filter((alias) => alias.providerId === providerId && alias.rawModelId === rawModelId && inInterval(alias.effectiveFrom, alias.effectiveUntil, at))
      return matches.length === 1 ? matches[0] : matches.length > 1 ? { status: 'ambiguous', reason: 'overlapping-exact-model-aliases' } : { status: 'unavailable', reason: 'no-exact-model-alias' }
    },
    resolve(providerId, modelId, purpose, at) {
      const histories = new Map<string, UserPricingPolicy[]>()
      for (const policy of policies().filter((row) => row.providerId === providerId && row.purpose === purpose && patternMatches(row.modelPattern, modelId) && Date.parse(row.updatedAt) <= Date.parse(at))) {
        histories.set(policy.policyId, [...(histories.get(policy.policyId) ?? []), policy])
      }
      const active = [...histories.values()].flatMap((history) => {
        const current = history.at(-1)
        if (!current || current.lifecycle === 'deleted') return []
        const undoneTargetRevisionId = current.lifecycle === 'undone' && current.supersedesRevisionId.status === 'available'
          ? current.supersedesRevisionId.value
          : undefined
        const undoneTarget = undoneTargetRevisionId
          ? history.find((revision) => revision.revisionId === undoneTargetRevisionId)
          : undefined
        const restoredRevisionId = undoneTarget?.supersedesRevisionId.status === 'available'
          ? undoneTarget.supersedesRevisionId.value
          : undefined
        const selected = current.lifecycle === 'undone'
          ? restoredRevisionId ? history.find((revision) => revision.revisionId === restoredRevisionId) : undefined
          : current
        return selected && inInterval(selected.effectiveFrom, selected.effectiveUntil, at) ? [selected] : []
      })
      return active.length === 1 ? active[0] : active.length > 1 ? { status: 'ambiguous', reason: 'overlapping-pricing-policies' } : { status: 'unavailable', reason: 'no-effective-pricing-policy' }
    },
    apply(command) {
      if ((command.kind === 'undo' || command.kind === 'delete') && !command.reason.trim()) return response(command.commandId, 'invalid', 'reason-required')
      if ((command.kind === 'undo' || command.kind === 'delete') && !validTimestamp(command.occurredAt)) return response(command.commandId, 'invalid', 'invalid-occurred-at')
      const submitted = command.kind === 'create' || command.kind === 'supersede' ? command.policy : undefined
      const policyId = command.kind === 'create' ? command.policy.policyId : command.policyId
      const current = head(policyId)
      if ((current?.revision ?? null) !== command.expectedHeadRevision) {
        const result = response(command.commandId, 'conflict', 'revision-conflict')
        result.headRevision = current ? { status: 'available', value: current.revision } : unavailable('policy-not-found')
        return result
      }
      if (submitted) {
        const invalid = validatePolicy(submitted)
        if (invalid) return response(command.commandId, 'invalid', invalid)
        if (submitted.policyId !== policyId) return response(command.commandId, 'invalid', 'policy-id-mismatch')
        if (command.kind === 'create' && (submitted.revision !== 1 || submitted.supersedesRevisionId.status === 'available')) return response(command.commandId, 'invalid', 'invalid-initial-revision')
        if (command.kind === 'supersede' && (!current || submitted.revision !== current.revision + 1 || submitted.supersedesRevisionId.status !== 'available' || submitted.supersedesRevisionId.value !== current.revisionId)) return response(command.commandId, 'invalid', 'invalid-supersede-chain')
        const overlapsOtherPolicy = policies().some((existing) => existing.policyId !== submitted.policyId && existing.lifecycle === 'active' &&
          existing.providerId === submitted.providerId && existing.purpose === submitted.purpose && existing.modelPattern === submitted.modelPattern &&
          Date.parse(existing.effectiveFrom) < (submitted.effectiveUntil.status === 'available' ? Date.parse(submitted.effectiveUntil.value) : Number.POSITIVE_INFINITY) &&
          Date.parse(submitted.effectiveFrom) < (existing.effectiveUntil.status === 'available' ? Date.parse(existing.effectiveUntil.value) : Number.POSITIVE_INFINITY))
        if (overlapsOtherPolicy) return response(command.commandId, 'conflict', 'overlapping-pricing-policies')
        try { insertPolicy.run(submitted.revisionId, submitted.policyId, submitted.revision, JSON.stringify(submitted)) } catch { return response(command.commandId, 'conflict', 'revision-id-conflict') }
        return response(command.commandId, 'applied', 'none', submitted)
      }
      if (!current) return response(command.commandId, 'unavailable', 'policy-not-found')
      if (current.lifecycle === 'deleted') return response(command.commandId, 'invalid', 'policy-already-deleted')
      const next: UserPricingPolicy = {
        ...current,
        revision: current.revision + 1,
        revisionId: `${current.policyId}:r${current.revision + 1}`,
        lifecycle: command.kind === 'undo' ? 'undone' : 'deleted',
        updatedAt: command.kind === 'undo' || command.kind === 'delete' ? command.occurredAt : current.updatedAt,
        supersedesRevisionId: { status: 'available', value: current.revisionId }
      }
      insertPolicy.run(next.revisionId, next.policyId, next.revision, JSON.stringify(next))
      return response(command.commandId, 'applied', 'none', next)
    },
    close: () => database.close()
  }
}

/** Compatibility helper; intentionally explicit in-memory storage for unit tests only. */
export function createPricingPolicyRepository(seed: readonly UserPricingPolicy[] = [], aliases: readonly UserModelAlias[] = []): PricingPolicyRepository {
  return openPricingPolicyRepository(':memory:', seed, aliases)
}

function calculate(rows: readonly UsageAttribution[], rates: UserPricingPolicy['rates']): number | undefined {
  let amount = 0
  for (const row of rows) {
    if (row.quantity.status !== 'available') return undefined
    const rate = rates.find((candidate) => candidate.quantityKind === row.quantityKind && candidate.unit === row.quantityUnit)
    if (!rate) continue
    amount += row.quantity.value / rate.unitSize * rate.price
  }
  return amount
}

export function valueUsageAttributions(input: {
  repository: PricingPolicyRepository
  usageFactId: string
  providerId: string
  rawModelId: string
  at: string
  usage: readonly UsageAttribution[]
  officialSnapshot?: OfficialPriceSnapshot
}): ValuationView {
  const alias = input.repository.resolveAlias(input.providerId, input.rawModelId, input.at)
  if ('status' in alias && alias.status === 'ambiguous') return {
    schemaVersion: 1, usageFactId: input.usageFactId, rawModelId: input.rawModelId,
    officialPriceSnapshot: input.officialSnapshot ? { status: 'available', value: input.officialSnapshot } : unavailable('official-snapshot-unavailable'),
    publicEquivalent: unavailable('ambiguous-model-alias'), actualContract: unavailable('ambiguous-model-alias'), resolution: 'ambiguous', evidence: []
  }
  const modelId = 'status' in alias ? input.rawModelId : alias.canonicalModelId
  const publicPolicy = input.repository.resolve(input.providerId, modelId, 'public-price-correction', input.at)
  const contractPolicy = input.repository.resolve(input.providerId, modelId, 'contract-price', input.at)
  const publicSource = !('status' in publicPolicy) ? publicPolicy : input.officialSnapshot
  const publicAmount = publicSource ? calculate(input.usage, publicSource.rates) : undefined
  const contractAmount = !('status' in contractPolicy) ? calculate(input.usage, contractPolicy.rates) : undefined
  const ambiguous = ('status' in publicPolicy && publicPolicy.status === 'ambiguous') || ('status' in contractPolicy && contractPolicy.status === 'ambiguous')
  return {
    schemaVersion: 1,
    usageFactId: input.usageFactId,
    rawModelId: input.rawModelId,
    officialPriceSnapshot: input.officialSnapshot ? { status: 'available', value: input.officialSnapshot } : unavailable('official-snapshot-unavailable'),
    publicEquivalent: publicAmount === undefined ? unavailable(ambiguous ? 'ambiguous-public-policy' : 'public-price-unavailable') : {
      status: 'available', value: {
        amount: publicAmount,
        currency: publicSource!.currency,
        source: 'status' in publicPolicy ? 'official-snapshot' : 'user-policy',
        policyRevisionId: 'status' in publicPolicy ? unavailable('official-snapshot-used') : { status: 'available', value: publicPolicy.revisionId }
      }
    },
    actualContract: contractAmount === undefined || 'status' in contractPolicy ? unavailable(ambiguous ? 'ambiguous-contract-policy' : 'contract-price-unavailable') : {
      status: 'available', value: { amount: contractAmount, currency: contractPolicy.currency, policyRevisionId: contractPolicy.revisionId }
    },
    resolution: ambiguous ? 'ambiguous' : publicAmount !== undefined || contractAmount !== undefined ? 'exact' : 'unavailable',
    evidence: [
      ...(!('status' in publicPolicy) ? publicPolicy.provenance : []),
      ...(!('status' in contractPolicy) ? contractPolicy.provenance : []),
      ...(!('status' in alias) ? alias.provenance : []),
      ...input.usage.flatMap((row) => row.evidence)
    ]
  }
}
