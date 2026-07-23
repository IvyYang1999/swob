import { randomUUID } from 'node:crypto'
import {
  builtinProviderForId
} from '../shared/provider-capabilities'
import {
  PROVIDER_PROTOCOL_VERSION,
  type Fingerprint,
  type ParseOutcome,
  type ProviderEnvelope,
  type ProviderError,
  type ProviderManifest,
  type SourceRef
} from '../shared/provider-schema.generated'
import {
  helloForProvider,
  providerFingerprint,
  validateProviderEnvelope,
  validateProviderManifest,
  validateProviderSourceRef
} from '../shared/provider-protocol'
import { createPiProvider } from './providers/pi-provider'
import { runtimeHome } from './runtime-home'

export const PROVIDER_RUNTIME_TIMEOUT_MS = 30_000
export const PROVIDER_SESSION_INPUT_LIMIT_BYTES = 50 * 1024 * 1024

export type ProviderRuntimeErrorCode =
  | 'timeout'
  | 'cancelled'
  | 'resource-limit-exceeded'
  | 'schema-validation-failed'
  | 'provider-failed'

export class ProviderRuntimeError extends Error {
  readonly code: ProviderRuntimeErrorCode
  readonly providerError: ProviderError

  constructor(code: ProviderRuntimeErrorCode, providerError: ProviderError) {
    super(providerError.message)
    this.name = 'ProviderRuntimeError'
    this.code = code
    this.providerError = providerError
  }
}

export interface BuiltinProviderRuntime {
  readonly manifest: ProviderManifest
  discover(signal: AbortSignal): Promise<SourceRef[]>
  fingerprint(source: SourceRef, signal: AbortSignal): Promise<Fingerprint>
  inputBytes(source: SourceRef, signal: AbortSignal): Promise<number>
  parse(source: SourceRef, fingerprint: Fingerprint, signal: AbortSignal): Promise<ParseOutcome>
}

export interface PreviousProviderSourceState {
  sourceRef: SourceRef
  fingerprint: Fingerprint
  sessionRecordIds: string[]
}

export interface ProviderRunReport {
  providerId: string
  manifest: ProviderManifest
  envelopes: ProviderEnvelope[]
  discoveredSources: SourceRef[]
  unchangedSources: SourceRef[]
  outcomes: ParseOutcome[]
  errors: ProviderRuntimeError[]
}

export interface ProviderHostRunOptions {
  previousSources?: Map<string, PreviousProviderSourceState[]>
}

export interface ProviderHostOptions {
  runtimes?: BuiltinProviderRuntime[]
  timeoutMs?: number
  maxSessionInputBytes?: number
  homeDir?: string
}

function protocolError(
  providerId: string,
  code: ProviderError['code'],
  message: string,
  sourceRefId: string | null = null,
  details: ProviderError['details'] = null
): ProviderError {
  return {
    code,
    message,
    retryable: false,
    providerId,
    sourceRefId,
    recordId: null,
    details
  }
}

function runtimeError(
  providerId: string,
  code: ProviderRuntimeErrorCode,
  message: string,
  sourceRefId: string | null = null,
  details: ProviderError['details'] = null
): ProviderRuntimeError {
  const providerCode: ProviderError['code'] = code === 'cancelled'
    ? 'cancelled'
    : code === 'resource-limit-exceeded'
      ? 'resource-limit-exceeded'
      : code === 'schema-validation-failed'
        ? 'schema-validation-failed'
        : 'internal'
  return new ProviderRuntimeError(
    code,
    protocolError(providerId, providerCode, message, sourceRefId, details)
  )
}

function envelopeFor(
  kind: ProviderEnvelope['kind'],
  payload: ProviderEnvelope['payload']
): ProviderEnvelope {
  return {
    protocolVersion: PROVIDER_PROTOCOL_VERSION,
    messageId: randomUUID(),
    kind,
    payload
  } as ProviderEnvelope
}

function assertValidEnvelope(providerId: string, envelope: ProviderEnvelope): ProviderEnvelope {
  const validation = validateProviderEnvelope(envelope)
  if (!validation.ok) {
    throw new ProviderRuntimeError(
      'schema-validation-failed',
      validation.error || protocolError(
        providerId,
        'schema-validation-failed',
        'Provider envelope failed schema validation.'
      )
    )
  }
  return validation.value!
}

function fingerprintEqual(left: Fingerprint, right: Fingerprint): boolean {
  return left.algorithm === right.algorithm && left.value === right.value &&
    JSON.stringify(left.inputs || []) === JSON.stringify(right.inputs || [])
}

function tombstoneOutcome(
  manifest: ProviderManifest,
  previous: PreviousProviderSourceState
): ParseOutcome {
  return {
    providerId: manifest.providerId,
    parserDataVersion: manifest.parserDataVersion,
    formatVersion: null,
    fingerprint: previous.fingerprint,
    status: 'no-data',
    sessions: [{
      sourceRefId: previous.sourceRef.stableId,
      sessionRecordId: null,
      status: 'no-data',
      records: [],
      errors: [],
      replaceSessionRecordId: null,
      noDataReason: 'empty-source'
    }],
    errors: [],
    tombstones: previous.sessionRecordIds.map((sessionRecordId) => ({
      sourceRefId: previous.sourceRef.stableId,
      sessionRecordId,
      deletedAt: new Date().toISOString(),
      reason: 'source-missing',
      previousFingerprint: previous.fingerprint
    }))
  }
}

function builtinRuntimes(homeDir: string): BuiltinProviderRuntime[] {
  return [createPiProvider({ homeDir })]
}

export class ProviderHost {
  private readonly runtimes: BuiltinProviderRuntime[]
  private readonly timeoutMs: number
  private readonly maxSessionInputBytes: number
  private readonly activeControllers = new Set<AbortController>()
  private cancelled = false

  constructor(options: ProviderHostOptions = {}) {
    this.runtimes = options.runtimes || builtinRuntimes(options.homeDir || runtimeHome())
    this.timeoutMs = options.timeoutMs ?? PROVIDER_RUNTIME_TIMEOUT_MS
    this.maxSessionInputBytes = options.maxSessionInputBytes ?? PROVIDER_SESSION_INPUT_LIMIT_BYTES
  }

  manifests(): ProviderManifest[] {
    return this.runtimes.map((runtime) => structuredClone(runtime.manifest))
  }

  cancelAll(): void {
    this.cancelled = true
    for (const controller of this.activeControllers) controller.abort('cancelled')
  }

  async runAll(options: ProviderHostRunOptions = {}): Promise<ProviderRunReport[]> {
    if (this.cancelled) {
      return this.runtimes.map((runtime) => ({
        providerId: runtime.manifest.providerId,
        manifest: runtime.manifest,
        envelopes: [],
        discoveredSources: [],
        unchangedSources: [],
        outcomes: [],
        errors: [runtimeError(runtime.manifest.providerId, 'cancelled', 'Provider host is cancelled.')]
      }))
    }
    return Promise.all(this.runtimes.map((runtime) => this.runProvider(
      runtime,
      options.previousSources?.get(runtime.manifest.providerId) || []
    )))
  }

  private async runProvider(
    runtime: BuiltinProviderRuntime,
    previousSources: PreviousProviderSourceState[]
  ): Promise<ProviderRunReport> {
    const providerId = runtime.manifest.providerId
    const report: ProviderRunReport = {
      providerId,
      manifest: runtime.manifest,
      envelopes: [],
      discoveredSources: [],
      unchangedSources: [],
      outcomes: [],
      errors: []
    }
    const controller = new AbortController()
    this.activeControllers.add(controller)
    let timeout: ReturnType<typeof setTimeout> | undefined

    try {
      const registryDefinition = builtinProviderForId(providerId)
      const manifestValidation = validateProviderManifest(runtime.manifest)
      if (!manifestValidation.ok || !registryDefinition ||
        providerFingerprint(registryDefinition.manifest) !== providerFingerprint(runtime.manifest)) {
        throw runtimeError(
          providerId,
          'schema-validation-failed',
          !registryDefinition
            ? `Provider ${providerId} is not registered in the builtin manifest registry.`
            : 'Provider runtime manifest does not match the builtin registry.'
        )
      }

      const hello = assertValidEnvelope(providerId, envelopeFor('hello', helloForProvider(runtime.manifest)))
      const manifest = assertValidEnvelope(providerId, envelopeFor('manifest', runtime.manifest))
      report.envelopes.push(hello, manifest)
      // Keep deadline work isolated until it completes. A provider that ignores
      // AbortSignal may continue running after the race, but it can no longer
      // mutate the report already returned to the app.
      const pendingReport: ProviderRunReport = {
        providerId,
        manifest: runtime.manifest,
        envelopes: [],
        discoveredSources: [],
        unchangedSources: [],
        outcomes: [],
        errors: []
      }

      const timeoutPromise = new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          controller.abort('timeout')
          reject(runtimeError(
            providerId,
            'timeout',
            `Provider ${providerId} exceeded the ${this.timeoutMs}ms runtime limit.`,
            null,
            { timeoutMs: this.timeoutMs, runtimeCode: 'timeout' }
          ))
        }, this.timeoutMs)
        timeout.unref?.()
      })
      const abortPromise = new Promise<never>((_resolve, reject) => {
        controller.signal.addEventListener('abort', () => {
          if (controller.signal.reason === 'timeout') return
          reject(runtimeError(providerId, 'cancelled', `Provider ${providerId} was cancelled.`))
        }, { once: true })
      })

      await Promise.race([
        this.runProviderWithinDeadline(runtime, previousSources, pendingReport, controller.signal),
        timeoutPromise,
        abortPromise
      ])
      report.envelopes.push(...pendingReport.envelopes)
      report.discoveredSources.push(...pendingReport.discoveredSources)
      report.unchangedSources.push(...pendingReport.unchangedSources)
      report.outcomes.push(...pendingReport.outcomes)
      report.errors.push(...pendingReport.errors)
    } catch (error) {
      report.errors.push(error instanceof ProviderRuntimeError
        ? error
        : runtimeError(providerId, 'provider-failed', error instanceof Error ? error.message : String(error)))
    } finally {
      if (timeout) clearTimeout(timeout)
      this.activeControllers.delete(controller)
    }
    return report
  }

  private async runProviderWithinDeadline(
    runtime: BuiltinProviderRuntime,
    previousSources: PreviousProviderSourceState[],
    report: ProviderRunReport,
    signal: AbortSignal
  ): Promise<void> {
    const providerId = runtime.manifest.providerId
    const previousById = new Map(previousSources.map((source) => [source.sourceRef.stableId, source]))
    const discoveredIds = new Set<string>()
    const processedIds = new Set<string>()
    const discovered = await runtime.discover(signal)

    for (const unvalidatedSource of discovered) {
      if (signal.aborted) throw runtimeError(providerId, 'cancelled', `Provider ${providerId} was cancelled.`)
      const candidateId = typeof unvalidatedSource?.stableId === 'string'
        ? unvalidatedSource.stableId
        : null
      // A provider that reports a source with malformed metadata has still
      // observed it. Preserve the last valid snapshot instead of turning a
      // schema failure into a destructive "source missing" tombstone.
      if (candidateId) discoveredIds.add(candidateId)
      const sourceValidation = validateProviderSourceRef(unvalidatedSource)
      if (!sourceValidation.ok) {
        report.errors.push(runtimeError(
          providerId,
          sourceValidation.error?.code === 'resource-limit-exceeded'
            ? 'resource-limit-exceeded'
            : 'schema-validation-failed',
          'Discovered source failed Provider Protocol schema validation.',
          candidateId,
          { issueCount: sourceValidation.issues.length }
        ))
        continue
      }
      const sourceTemplate = sourceValidation.value!
      if (sourceTemplate.providerId !== providerId) {
        report.errors.push(runtimeError(
          providerId,
          'schema-validation-failed',
          'Discovered source providerId does not match its runtime manifest.',
          sourceTemplate.stableId
        ))
        continue
      }
      if (processedIds.has(sourceTemplate.stableId)) {
        report.errors.push(runtimeError(
          providerId,
          'schema-validation-failed',
          'Provider discovery returned the same stable source id more than once.',
          sourceTemplate.stableId
        ))
        continue
      }
      processedIds.add(sourceTemplate.stableId)
      try {
        const fingerprint = await runtime.fingerprint(sourceTemplate, signal)
        const source = { ...sourceTemplate, fingerprint } as SourceRef
        report.discoveredSources.push(source)
        const previous = previousById.get(source.stableId)
        if (previous && fingerprintEqual(previous.fingerprint, fingerprint)) {
          report.unchangedSources.push(source)
          continue
        }
        const inputBytes = await runtime.inputBytes(source, signal)
        if (!Number.isSafeInteger(inputBytes) || inputBytes < 0 || inputBytes > this.maxSessionInputBytes) {
          throw runtimeError(
            providerId,
            'resource-limit-exceeded',
            `Provider source exceeds the ${this.maxSessionInputBytes} byte per-session parse limit.`,
            source.stableId,
            { actual: inputBytes, limit: this.maxSessionInputBytes, limitName: 'maxSessionInputBytes' }
          )
        }
        const parsedOutcome = await runtime.parse(source, fingerprint, signal)
        let outcome: ParseOutcome = previous && parsedOutcome.status === 'complete'
          ? {
              ...parsedOutcome,
              status: 'replace',
              sessions: parsedOutcome.sessions.map((session) => session.sessionRecordId
                ? {
                    ...session,
                    status: 'replace',
                    replaceSessionRecordId: session.sessionRecordId
                  }
                : session)
            }
          : parsedOutcome
        if (previous && outcome.status !== 'error') {
          const currentSessionIds = new Set(outcome.sessions.flatMap((session) =>
            session.sessionRecordId ? [session.sessionRecordId] : []))
          const removedSessions = previous.sessionRecordIds.filter((sessionRecordId) =>
            !currentSessionIds.has(sessionRecordId))
          if (removedSessions.length > 0) {
            outcome = {
              ...outcome,
              tombstones: [
                ...outcome.tombstones,
                ...removedSessions.map((sessionRecordId) => ({
                  sourceRefId: source.stableId,
                  sessionRecordId,
                  deletedAt: new Date().toISOString(),
                  reason: 'replaced' as const,
                  previousFingerprint: previous.fingerprint
                }))
              ]
            }
          }
        }
        const envelope = assertValidEnvelope(providerId, envelopeFor('parse-outcome', outcome))
        if (envelope.kind !== 'parse-outcome' || envelope.payload.providerId !== providerId) {
          throw runtimeError(
            providerId,
            'schema-validation-failed',
            'Parse outcome providerId does not match its runtime manifest.',
            source.stableId
          )
        }
        report.envelopes.push(envelope)
        report.outcomes.push(envelope.payload)
      } catch (error) {
        report.errors.push(error instanceof ProviderRuntimeError
          ? error
          : runtimeError(
            providerId,
            signal.aborted ? 'cancelled' : 'provider-failed',
            error instanceof Error ? error.message : String(error),
            sourceTemplate.stableId
          ))
      }
    }

    for (const previous of previousSources) {
      if (discoveredIds.has(previous.sourceRef.stableId)) continue
      const outcome = tombstoneOutcome(runtime.manifest, previous)
      const envelope = assertValidEnvelope(providerId, envelopeFor('parse-outcome', outcome))
      report.envelopes.push(envelope)
      report.outcomes.push(outcome)
    }
  }
}
