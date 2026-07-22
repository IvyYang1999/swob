/**
 * @vitest-environment jsdom
 */
import { act, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const store = vi.hoisted(() => ({
  state: {
    sessions: [] as any[],
    selectSession: vi.fn(),
    setWorkspaceView: vi.fn(),
    locale: 'zh-CN'
  }
}))

vi.mock('../store', () => ({
  useStore: (selector: (state: typeof store.state) => unknown) => selector(store.state)
}))

import { LineagePage, lineageGraphFingerprint } from './LineagePage'

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

  it('debounces genuine graph changes and rebuilds once after the burst', async () => {
    const view = render(<LineagePage />)
    for (let index = 0; index < 20; index++) {
      store.state.sessions = [session({ turnCount: 4 + index })]
      view.rerender(<LineagePage />)
      await act(async () => { vi.advanceTimersByTime(25) })
    }
    expect(getLineageRegistry).not.toHaveBeenCalled()

    await act(async () => { vi.advanceTimersByTime(500) })
    expect(getLineageRegistry).toHaveBeenCalledTimes(1)
  })
})
