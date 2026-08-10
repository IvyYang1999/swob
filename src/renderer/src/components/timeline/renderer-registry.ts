import type { CanonicalEvent, CanonicalEventKind, JsonValue } from '../../../../shared/provider-schema-v2.generated'
import type { PersistedOutputRef, ProviderRegistrationDescriptor } from '../../../../shared/contracts/truth-kernel'
import { createT211BTranslator, type T211BTranslationKey, type T211BTranslator } from './translations'

export { T211B_TRANSLATIONS } from './translations'

export type TimelineCardKind =
  | 'text' | 'thinking' | 'redacted-thinking' | 'reasoning' | 'tool-call' | 'tool-progress'
  | 'tool-result' | 'tool-error' | 'tool-cancelled' | 'interaction-request' | 'interaction-response'
  | 'permission-request' | 'permission-response' | 'compact' | 'context-summary' | 'model'
  | 'mode' | 'lifecycle' | 'subagent' | 'subagent-progress' | 'subagent-result' | 'artifact' | 'unknown'

export interface TimelineRenderModel {
  card: TimelineCardKind
  title: string
  detail: string | null
  payload: JsonValue
  copyable: boolean
  exportable: boolean
}

function object(value: JsonValue): Record<string, JsonValue> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, JsonValue>
    : null
}

function text(value: JsonValue | undefined): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function json(value: JsonValue): string {
  return JSON.stringify(value, null, 2)
}

/**
 * The registry is deliberately keyed by canonical event kind, rather than a
 * provider name. Providers add events through the frozen contract; this host
 * decides only how an already-preserved event is read.
 */
export function renderTimelineEvent(event: CanonicalEvent, t: T211BTranslator = createT211BTranslator('en')): TimelineRenderModel {
  const payload = object(event.payload)
  switch (event.kind) {
    case 'message.text': return { card: 'text', title: event.actor === 'user' ? t('timeline.actor.user') : t('timeline.message'), detail: text(payload?.text), payload: event.payload, copyable: true, exportable: true }
    case 'message.thinking': return { card: 'thinking', title: t('timeline.thinking'), detail: text(payload?.text), payload: event.payload, copyable: true, exportable: true }
    case 'message.redacted-thinking': return { card: 'redacted-thinking', title: t('timeline.redactedThinking'), detail: text(payload?.reason) ?? t('timeline.redactedThinking.withheld'), payload: event.payload, copyable: true, exportable: true }
    case 'message.reasoning': return { card: 'reasoning', title: t('timeline.reasoning'), detail: text(payload?.text), payload: event.payload, copyable: true, exportable: true }
    case 'tool.call': return { card: 'tool-call', title: text(payload?.rawName) ?? t('timeline.tool.call'), detail: payload ? json(payload.input ?? null) : null, payload: event.payload, copyable: true, exportable: true }
    case 'tool.progress': return { card: event.actor === 'subagent' ? 'subagent-progress' : 'tool-progress', title: event.actor === 'subagent' ? t('timeline.subagent.progress') : t('timeline.tool.progress'), detail: payload ? json(payload.output ?? null) : null, payload: event.payload, copyable: true, exportable: true }
    case 'tool.result': {
      const state = text(payload?.state)
      return event.actor === 'subagent'
        ? { card: 'subagent-result', title: t('timeline.subagent.result'), detail: payload ? json(payload.output ?? null) : null, payload: event.payload, copyable: true, exportable: true }
        : { card: state === 'error' ? 'tool-error' : state === 'cancelled' ? 'tool-cancelled' : 'tool-result', title: state === 'error' ? t('timeline.tool.error') : state === 'cancelled' ? t('timeline.tool.cancelled') : t('timeline.tool.result'), detail: payload ? json(payload.output ?? null) : null, payload: event.payload, copyable: true, exportable: true }
    }
    case 'interaction.request': return { card: 'interaction-request', title: t('timeline.question'), detail: text(payload?.prompt), payload: event.payload, copyable: true, exportable: true }
    case 'interaction.response': return { card: 'interaction-response', title: t('timeline.response'), detail: payload ? json(payload.answers ?? []) : null, payload: event.payload, copyable: true, exportable: true }
    case 'permission.request': return { card: 'permission-request', title: text(payload?.permission) ? t('timeline.permission.named', { permission: text(payload?.permission)! }) : t('timeline.permission.requested'), detail: payload ? json(payload.resource ?? null) : null, payload: event.payload, copyable: true, exportable: true }
    case 'permission.response': return { card: 'permission-response', title: text(payload?.decision) ? t('timeline.permission.decision', { decision: text(payload?.decision)! }) : t('timeline.permission.response'), detail: null, payload: event.payload, copyable: true, exportable: true }
    case 'context.compaction': return { card: 'compact', title: t('timeline.compacted'), detail: payload ? t('timeline.compacted.detail', { sequence: String(payload.archivedThroughSequence ?? t('timeline.unknownType')) }) : null, payload: event.payload, copyable: true, exportable: true }
    case 'context.summary': return { card: 'context-summary', title: t('timeline.compactSummary'), detail: text(payload?.text), payload: event.payload, copyable: true, exportable: true }
    case 'model.changed': return { card: 'model', title: t('timeline.modelChanged'), detail: text(payload?.toModelId), payload: event.payload, copyable: true, exportable: true }
    case 'mode.changed': return { card: 'mode', title: t('timeline.modeChanged'), detail: text(payload?.toMode), payload: event.payload, copyable: true, exportable: true }
    case 'session.metadata': return { card: 'lifecycle', title: t('timeline.sessionMetadata'), detail: payload ? json(payload) : null, payload: event.payload, copyable: true, exportable: true }
    case 'session.lifecycle': return { card: 'lifecycle', title: t('timeline.sessionLifecycle'), detail: payload ? json(payload) : null, payload: event.payload, copyable: true, exportable: true }
    case 'subagent.spawn': return { card: 'subagent', title: t('timeline.subagentStarted'), detail: payload ? json(payload) : null, payload: event.payload, copyable: true, exportable: true }
    case 'artifact': return { card: 'artifact', title: t('timeline.artifactReference'), detail: payload ? json(payload) : null, payload: event.payload, copyable: true, exportable: true }
    case 'rollback': return { card: 'lifecycle', title: t('timeline.rollback'), detail: payload ? json(payload) : null, payload: event.payload, copyable: true, exportable: true }
    case 'usage': return { card: 'lifecycle', title: t('timeline.usage'), detail: payload ? json(payload) : null, payload: event.payload, copyable: true, exportable: true }
    case 'unknown': return { card: 'unknown', title: t('timeline.unknown', { type: text(payload?.rawType) ?? t('timeline.unknownType') }), detail: payload ? json(payload.rawPayload ?? event.payload) : json(event.payload), payload: event.payload, copyable: true, exportable: true }
    default: return exhaustive(event.kind, event, t)
  }
}

function exhaustive(kind: never, event: CanonicalEvent, t: T211BTranslator): TimelineRenderModel {
  return { card: 'unknown', title: t('timeline.unknown', { type: String(kind) }), detail: json(event.payload), payload: event.payload, copyable: true, exportable: true }
}

const OUTPUT_KIND_KEY: Record<PersistedOutputRef['outputKind'], T211BTranslationKey> = {
  image: 'timeline.outputKind.image', pdf: 'timeline.outputKind.pdf', document: 'timeline.outputKind.document',
  'structured-media': 'timeline.outputKind.structuredMedia', 'tool-output': 'timeline.outputKind.toolOutput', unknown: 'timeline.outputKind.unknown'
}
const CONTENT_STATE_KEY: Record<PersistedOutputRef['contentState'], T211BTranslationKey> = {
  available: 'timeline.contentState.available', missing: 'timeline.contentState.missing',
  'outside-allowed-root': 'timeline.contentState.outsideAllowedRoot', 'hash-mismatch': 'timeline.contentState.hashMismatch',
  unavailable: 'timeline.contentState.unavailable'
}

export function persistedOutputSummary(output: PersistedOutputRef, t: T211BTranslator = createT211BTranslator('en')): string {
  const size = output.sizeBytes.status === 'available' ? t('timeline.bytes', { count: output.sizeBytes.value }) : output.sizeBytes.reason
  const mime = output.mimeType.status === 'available' ? output.mimeType.value : output.mimeType.reason
  const digest = output.digest.status === 'available' ? output.digest.value : output.digest.reason
  return `${t(OUTPUT_KIND_KEY[output.outputKind])} · ${t(CONTENT_STATE_KEY[output.contentState])} · ${mime} · ${size} · ${digest}`
}

export const T211B_PROVIDER_REGISTRATION: ProviderRegistrationDescriptor = {
  schemaVersion: 1,
  featureId: 't211B-agent-timeline',
  providerId: 'swob/agent-timeline-renderer',
  descriptorVersion: '1.0.0',
  capabilityContractVersion: '2.0',
  registrationExport: 'T211B_TIMELINE_RENDERER_REGISTRY'
}

export const T211B_TIMELINE_RENDERER_REGISTRY: Readonly<Record<CanonicalEventKind, TimelineCardKind>> = {
  'message.text': 'text', 'message.thinking': 'thinking', 'message.redacted-thinking': 'redacted-thinking', 'message.reasoning': 'reasoning',
  'tool.call': 'tool-call', 'tool.progress': 'tool-progress', 'tool.result': 'tool-result', 'interaction.request': 'interaction-request',
  'interaction.response': 'interaction-response', 'permission.request': 'permission-request', 'permission.response': 'permission-response',
  'context.compaction': 'compact', 'context.summary': 'context-summary', 'model.changed': 'model', 'mode.changed': 'mode',
  'session.metadata': 'lifecycle', 'session.lifecycle': 'lifecycle', 'subagent.spawn': 'subagent', 'rollback': 'lifecycle', 'usage': 'lifecycle', artifact: 'artifact', unknown: 'unknown'
}
