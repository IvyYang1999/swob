/**
 * @vitest-environment jsdom
 */
import { act, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const store = vi.hoisted(() => ({
  state: {
    sessions: [] as any[],
    selectSession: vi.fn(),
    openSession: vi.fn(),
    setWorkspaceView: vi.fn(),
    locale: 'zh-CN'
  }
}))

vi.mock('../store', () => ({
  useStore: (selector: (state: typeof store.state) => unknown) => selector(store.state)
}))

import { LineagePage, lineageGraphFingerprint, computeMembershipKey } from './LineagePage'
import { hashString, stableSessionKey } from '../graph/stable-layout'

function session(overrides: Record<string, unknown> = {}) {
  return {
    id: 'session-1',
    sessionId: 'session-1',
    source: 'claude-code',
    projectPath: '/tmp/project',
    firstUserMessage: 'hello',
    turnCount: 3,
    createdAt: '2026-07-21T10:00:00.000Z',
    updatedAt: '2026-07-21T11:00:00.000Z',
    tokenUsage: { totalTokens: 100 },
    compactCount: 0,
    cwds: ['/tmp/project'],
    referencedFiles: [{ path: '/tmp/project/a.ts' }],
    ...overrides
  }
}

describe('LineagePage layout invalidation', () => {
  const getLineageRegistry = vi.fn(() => new Promise(() => {}))

  beforeEach(() => {
    vi.useFakeTimers()
    getLineageRegistry.mockClear()
    store.state.sessions = [session()]
    ;(window as any).api = { getLineageRegistry }
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('ignores library-only identity and metadata patches', async () => {
    const initial = lineageGraphFingerprint(store.state.sessions as any)
    const patched = [session({
      updatedAt: '2026-07-22T01:00:00.000Z',
      libraryMdPath: '/tmp/library/session.md',
      isRemote: true
    })]
    expect(lineageGraphFingerprint(patched as any)).toBe(initial)

    const view = render(<LineagePage />)
    await act(async () => { vi.advanceTimersByTime(500) })
    expect(getLineageRegistry).toHaveBeenCalledTimes(1)

    store.state.sessions = patched
    view.rerender(<LineagePage />)
    await act(async () => { vi.advanceTimersByTime(1_000) })
    expect(getLineageRegistry).toHaveBeenCalledTimes(1)
  })

  it('does NOT rebuild when only turnCount changes (presentation-only update)', async () => {
    const view = render(<LineagePage />)
    await act(async () => { vi.advanceTimersByTime(500) })
    expect(getLineageRegistry).toHaveBeenCalledTimes(1)

    // Changing turnCount should NOT trigger a rebuild — membership is unchanged
    store.state.sessions = [session({ turnCount: 999 })]
    view.rerender(<LineagePage />)
    await act(async () => { vi.advanceTimersByTime(1_000) })
    // Still only 1 call — no rebuild triggered
    expect(getLineageRegistry).toHaveBeenCalledTimes(1)
  })

  it('does NOT rebuild when only totalTokens changes', async () => {
    const view = render(<LineagePage />)
    await act(async () => { vi.advanceTimersByTime(500) })
    expect(getLineageRegistry).toHaveBeenCalledTimes(1)

    store.state.sessions = [session({ tokenUsage: { totalTokens: 999999 } })]
    view.rerender(<LineagePage />)
    await act(async () => { vi.advanceTimersByTime(1_000) })
    expect(getLineageRegistry).toHaveBeenCalledTimes(1)
  })

  it('does NOT rebuild when only compactCount changes', async () => {
    const view = render(<LineagePage />)
    await act(async () => { vi.advanceTimersByTime(500) })
    expect(getLineageRegistry).toHaveBeenCalledTimes(1)

    store.state.sessions = [session({ compactCount: 5 })]
    view.rerender(<LineagePage />)
    await act(async () => { vi.advanceTimersByTime(1_000) })
    expect(getLineageRegistry).toHaveBeenCalledTimes(1)
  })

  it('DOES rebuild when a new session is added (membership change)', async () => {
    const view = render(<LineagePage />)
    await act(async () => { vi.advanceTimersByTime(500) })
    expect(getLineageRegistry).toHaveBeenCalledTimes(1)

    // Add a new session — membership key changes
    store.state.sessions = [
      session(),
      session({ id: 'session-2', sessionId: 'session-2', firstUserMessage: 'world' })
    ]
    view.rerender(<LineagePage />)
    await act(async () => { vi.advanceTimersByTime(500) })
    expect(getLineageRegistry).toHaveBeenCalledTimes(2)
  })

  it('DOES rebuild when a session is removed (membership change)', async () => {
    store.state.sessions = [
      session(),
      session({ id: 'session-2', sessionId: 'session-2' })
    ]
    const view = render(<LineagePage />)
    await act(async () => { vi.advanceTimersByTime(500) })
    expect(getLineageRegistry).toHaveBeenCalledTimes(1)

    // Remove second session
    store.state.sessions = [session()]
    view.rerender(<LineagePage />)
    await act(async () => { vi.advanceTimersByTime(500) })
    expect(getLineageRegistry).toHaveBeenCalledTimes(2)
  })
})

describe('Stable layout utilities', () => {
  it('hashString produces consistent deterministic output', () => {
    const h1 = hashString('test-session-id')
    const h2 = hashString('test-session-id')
    expect(h1).toBe(h2)
    expect(typeof h1).toBe('number')
    expect(h1).toBeGreaterThanOrEqual(0)
  })

  it('hashString produces different values for different inputs', () => {
    const h1 = hashString('session-A')
    const h2 = hashString('session-B')
    expect(h1).not.toBe(h2)
  })

  it('stableSessionKey is deterministic and order-independent', () => {
    const k1 = stableSessionKey('claude-code', 'id-1', 'sid-1')
    const k2 = stableSessionKey('claude-code', 'id-1', 'sid-1')
    expect(k1).toBe(k2)
    expect(k1).toBe('claude-code:id-1:sid-1')
  })

  it('computeMembershipKey ignores turnCount, tokens, compactCount', () => {
    const s1 = [session({ turnCount: 1, tokenUsage: { totalTokens: 100 }, compactCount: 0 })]
    const s2 = [session({ turnCount: 999, tokenUsage: { totalTokens: 999999 }, compactCount: 10 })]
    expect(computeMembershipKey(s1 as any)).toBe(computeMembershipKey(s2 as any))
  })

  it('computeMembershipKey is input-order independent', () => {
    const sessions = [
      session({ id: 'A', sessionId: 'A', source: 'claude-code' }),
      session({ id: 'B', sessionId: 'B', source: 'codex' })
    ]
    const reversed = [sessions[1], sessions[0]]
    expect(computeMembershipKey(sessions as any)).toBe(computeMembershipKey(reversed as any))
  })

  it('computeMembershipKey changes when session identity changes', () => {
    const s1 = [session({ id: 'A', sessionId: 'A' })]
    const s2 = [session({ id: 'B', sessionId: 'B' })]
    expect(computeMembershipKey(s1 as any)).not.toBe(computeMembershipKey(s2 as any))
  })
})
