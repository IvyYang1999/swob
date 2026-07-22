// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

const baseConfig = {
  folders: [],
  sessionMeta: {},
  preferences: {
    defaultViewMode: 'compact',
    terminalApp: 'Terminal'
  }
}

describe('renderer preference persistence', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.useFakeTimers()
    localStorage.clear()
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn(() => ({
        matches: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn()
      }))
    })
  })

  it('keeps local preference fields across stale Library patches and refreshes', async () => {
    let libraryPatch!: (patch: { sessions: unknown[]; config?: typeof baseConfig }) => void
    let sessionsRefresh!: () => void
    let resolveFirstSave!: (value: unknown) => void
    const saveConfig = vi.fn()
      .mockImplementationOnce((config: unknown) => new Promise((resolve) => {
        resolveFirstSave = () => resolve(config)
      }))
      .mockImplementation((config: unknown) => Promise.resolve(config))

    ;(window as any).api = {
      onLibraryPatch: (callback: typeof libraryPatch) => { libraryPatch = callback },
      loadAllSessions: vi.fn(async () => []),
      loadConfig: vi.fn(async () => structuredClone(baseConfig)),
      getSystemLocale: vi.fn(async () => 'en'),
      saveConfig,
      onSessionAdded: vi.fn(),
      onSessionUpdated: vi.fn(),
      onSessionSummaryUpdated: vi.fn(),
      onSessionsRefresh: (callback: () => void) => { sessionsRefresh = callback },
      getActiveSessions: vi.fn(async () => []),
      onActiveSessionsChanged: vi.fn(),
      onSpotlightNavigate: vi.fn()
    }

    const { useStore } = await import('./store')
    await useStore.getState().initialize()

    const themeSave = useStore.getState().savePreferences({ themeMode: 'dark' })
    libraryPatch({ sessions: [], config: structuredClone(baseConfig) })
    sessionsRefresh()
    await vi.advanceTimersByTimeAsync(500)

    expect(useStore.getState().config?.preferences.themeMode).toBe('dark')

    const schemeSave = useStore.getState().savePreferences({ colorScheme: 'nord' })
    expect(saveConfig).toHaveBeenNthCalledWith(2, expect.objectContaining({
      preferences: expect.objectContaining({ themeMode: 'dark', colorScheme: 'nord' })
    }))

    resolveFirstSave(undefined)
    await Promise.all([themeSave, schemeSave])
    expect(useStore.getState().config?.preferences).toMatchObject({
      themeMode: 'dark',
      colorScheme: 'nord'
    })
  })
})
