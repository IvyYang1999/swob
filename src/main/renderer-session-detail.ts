import type { ParsedMessage, SessionDetail } from './types'

type RendererMessage = Pick<
  ParsedMessage,
  'uuid' | 'type' | 'timestamp' | 'textContent' | 'toolCalls' | 'images'
> & Partial<Pick<
  ParsedMessage,
  'subtype' | 'tokenUsage' | 'isSidechain' | 'isSharedContext' | 'isSystemGenerated'
>>

function toRendererMessage(message: ParsedMessage): RendererMessage {
  return {
    uuid: message.uuid,
    type: message.type,
    timestamp: message.timestamp,
    textContent: message.textContent,
    toolCalls: message.toolCalls,
    images: message.images,
    ...(message.subtype ? { subtype: message.subtype } : {}),
    ...(message.tokenUsage ? { tokenUsage: message.tokenUsage } : {}),
    ...(message.isSidechain ? { isSidechain: true } : {}),
    ...(message.isSharedContext ? { isSharedContext: true } : {}),
    ...(message.isSystemGenerated ? { isSystemGenerated: true } : {})
  }
}

/**
 * Build the renderer IPC DTO without raw transcript records or main-only fields.
 * Besides reducing trust surface, this keeps large-session structured cloning
 * from monopolizing the renderer thread.
 */
export function toRendererSessionDetail(detail: SessionDetail | null): SessionDetail | null {
  if (!detail) return null
  return {
    ...detail,
    messages: detail.messages.map(toRendererMessage) as ParsedMessage[]
  }
}
