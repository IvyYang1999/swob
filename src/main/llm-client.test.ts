import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { callLlm } from './llm-client'

const settings = { provider: 'openai' as const, credential: 'test-only', model: 'test-model' }

describe('callLlm timeouts and cancellation', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('fails with a connection timeout after 30 seconds', async () => {
    vi.stubGlobal('fetch', vi.fn((_url, init?: RequestInit) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })
    })))

    const request = callLlm(settings, 'system', 'user')
    const rejection = expect(request).rejects.toMatchObject({ code: 'llm-connect-timeout' })
    await vi.advanceTimersByTimeAsync(30_000)
    await rejection
  })

  it('fails with a total timeout after the connection succeeds', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: () => new Promise(() => {})
    })))

    const request = callLlm(settings, 'system', 'user')
    const rejection = expect(request).rejects.toMatchObject({ code: 'llm-total-timeout' })
    await vi.advanceTimersByTimeAsync(120_000)
    await rejection
  })

  it('propagates user cancellation', async () => {
    const controller = new AbortController()
    vi.stubGlobal('fetch', vi.fn((_url, init?: RequestInit) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })
    })))

    const request = callLlm(settings, 'system', 'user', 4096, { signal: controller.signal })
    controller.abort()
    await expect(request).rejects.toMatchObject({ code: 'llm-cancelled' })
  })

  it.each([401, 503])('returns a stable error code for provider HTTP %s failures', async (status) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status })))
    await expect(callLlm(settings, 'system', 'user')).rejects.toMatchObject({
      code: `llm-http-${status}`
    })
  })
})
