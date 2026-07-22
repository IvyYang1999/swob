import { describe, expect, it } from 'vitest'
import { dataUrlToBase64 } from './ShareRenderer'
import type { ShareMessage } from './ShareRenderer'

// Note: renderShareImage relies on DOM APIs (document.createElement, Image, Canvas)
// and cannot run in a pure Node environment. We test the pure utility functions here;
// the renderer itself is verified via the type check and manual/E2E testing.

describe('dataUrlToBase64', () => {
  it('strips data URL prefix', () => {
    const dataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk'
    const result = dataUrlToBase64(dataUrl)
    expect(result).toBe('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk')
  })

  it('handles data URL without comma (edge case)', () => {
    const input = 'rawbase64content'
    const result = dataUrlToBase64(input)
    expect(result).toBe('rawbase64content')
  })

  it('handles empty data URL', () => {
    const result = dataUrlToBase64('data:image/png;base64,')
    expect(result).toBe('')
  })
})

describe('ShareMessage type', () => {
  it('satisfies the interface shape', () => {
    const msg: ShareMessage = {
      uuid: 'test-uuid',
      role: 'user',
      text: 'Hello world',
      timestamp: '2024-01-01T00:00:00Z',
    }
    expect(msg.uuid).toBe('test-uuid')
    expect(msg.role).toBe('user')
    expect(msg.text).toBe('Hello world')
  })

  it('allows assistant with tool calls', () => {
    const msg: ShareMessage = {
      uuid: 'asst-uuid',
      role: 'assistant',
      text: 'I will edit the file.',
      toolCalls: [{ name: 'Edit' }, { name: 'Bash' }],
    }
    expect(msg.toolCalls).toHaveLength(2)
    expect(msg.toolCalls![0].name).toBe('Edit')
  })
})
