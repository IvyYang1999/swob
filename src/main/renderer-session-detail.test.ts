import { describe, expect, it } from 'vitest'
import { toRendererSessionDetail } from './renderer-session-detail'
import type { ParsedMessage, SessionDetail } from './types'

function message(overrides: Partial<ParsedMessage> = {}): ParsedMessage {
  return {
    uuid: 'message-1',
    type: 'user',
    timestamp: '2026-07-21T10:00:00.000Z',
    origin: 'human',
    textContent: 'hello',
    toolCalls: [],
    images: [],
    isPreCompact: false,
    isSidechain: false,
    isSharedContext: false,
    isSystemGenerated: false,
    raw: { type: 'user', message: { role: 'user', content: 'hello' } } as ParsedMessage['raw'],
    ...overrides
  }
}

describe('toRendererSessionDetail', () => {
  it('omits transcript raw data and false/default main-only fields', () => {
    const detail = {
      sessionId: 'session-1',
      messages: [message()]
    } as SessionDetail

    const result = toRendererSessionDetail(detail)!
    expect(result.messages[0]).toEqual({
      uuid: 'message-1',
      type: 'user',
      timestamp: '2026-07-21T10:00:00.000Z',
      textContent: 'hello',
      toolCalls: [],
      images: []
    })
    expect(result.messages[0]).not.toHaveProperty('raw')
    expect(result.messages[0]).not.toHaveProperty('origin')
  })

  it('preserves renderer-visible optional data when present', () => {
    const detail = {
      sessionId: 'session-1',
      messages: [message({
        subtype: 'command-output',
        isSidechain: true,
        isSharedContext: true,
        isSystemGenerated: true,
        tokenUsage: {
          inputTokens: 1,
          outputTokens: 2,
          cacheCreationTokens: 3,
          cacheReadTokens: 4
        }
      })]
    } as SessionDetail

    expect(toRendererSessionDetail(detail)!.messages[0]).toMatchObject({
      subtype: 'command-output',
      isSidechain: true,
      isSharedContext: true,
      isSystemGenerated: true,
      tokenUsage: { inputTokens: 1, outputTokens: 2 }
    })
  })
})
