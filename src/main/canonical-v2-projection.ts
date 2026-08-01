import type { CanonicalEvent, JsonValue } from '../shared/provider-schema-v2.generated'
import {
  createBuiltinToolRegistryV2,
  type ToolRegistryV2
} from '../shared/tool-registry-v2'
import { stripTerminalControlSequences, stripTerminalControlSequencesDeep } from '../shared/chat-format'

export interface RenderedCanonicalEventV2 {
  id: string
  sequence: number
  kind: CanonicalEvent['kind']
  actor: CanonicalEvent['actor']
  text: string
  visibility: CanonicalEvent['visibility']
  archived: true
  modelContext: CanonicalEvent['timeline']['modelContext']
  semanticToolId: string | null
  component: string | null
  payload: JsonValue
}

function objectPayload(payload: JsonValue): Record<string, JsonValue> | null {
  return payload && typeof payload === 'object' && !Array.isArray(payload)
    ? payload as Record<string, JsonValue>
    : null
}

function payloadText(payload: JsonValue): string {
  const object = objectPayload(payload)
  if (object && typeof object.text === 'string') return stripTerminalControlSequences(object.text)
  try { return JSON.stringify(stripTerminalControlSequencesDeep(payload)) }
  catch { return String(payload) }
}

export function renderCanonicalEventPage(
  events: CanonicalEvent[],
  registry: ToolRegistryV2 = createBuiltinToolRegistryV2()
): RenderedCanonicalEventV2[] {
  return events.map((event) => {
    const payload = objectPayload(event.payload)
    const resolved = event.kind === 'tool.call' && payload &&
      typeof payload.rawName === 'string' && typeof payload.callId === 'string'
      ? registry.resolve({
          providerId: event.provenance.providerId,
          formatVersion: event.provenance.formatVersion,
          rawName: payload.rawName,
          callId: payload.callId,
          input: payload.input ?? null
        })
      : null
    return {
      id: event.id,
      sequence: event.sequence,
      kind: event.kind,
      actor: event.actor,
      text: payloadText(event.payload),
      visibility: event.visibility,
      archived: event.timeline.archived,
      modelContext: structuredClone(event.timeline.modelContext),
      semanticToolId: resolved?.semanticToolId || null,
      component: resolved?.presentation.component || null,
      payload: resolved ? resolved.normalizedInput : structuredClone(event.payload)
    }
  })
}
