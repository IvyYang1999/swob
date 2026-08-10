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

  it('keeps cached sessions visible until the source snapshot arrives, then merges provider additions', async () => {
    const cachedProviderSession = {
      id: 'cached-provider',
      sessionId: 'cached-provider',
      source: 'pi',
      updatedAt: '2026-08-08T00:00:00Z'
    }
    const cachedPhysicalSession = {
      id: 'cached-physical',
      sessionId: 'cached-physical',
      source: 'claude-code',
      updatedAt: '2026-08-08T00:00:00Z'
    }
    const sourceSessions = Array.from({ length: 1_500 }, (_, index) => ({
      id: `legacy-${index}`,
      sessionId: `legacy-${index}`,
      updatedAt: '2026-08-09T00:00:00Z'
    }))
    const providerSessions = Array.from({ length: 10 }, (_, index) => ({
      id: `provider-${index}`,
      sessionId: `provider-${index}`,
      source: 'pi',
      updatedAt: '2026-08-09T00:01:00Z'
    }))
    let resolveSource!: (sessions: unknown[]) => void
    const sourceFlight = new Promise<unknown[]>((resolve) => { resolveSource = resolve })
    let resolveRefresh!: (sessions: unknown[]) => void
    const refreshFlight = new Promise<unknown[]>((resolve) => { resolveRefresh = resolve })
    let providerPatch!: (patch: { sessions: unknown[]; status: 'complete' | 'degraded' }) => void
    let libraryPatch!: (patch: { sessions: unknown[]; config?: typeof baseConfig }) => void
    let sessionsRefresh!: () => void

    localStorage.setItem('csm:cacheVersion', '12')
    localStorage.setItem('csm:sessions', JSON.stringify([cachedProviderSession, cachedPhysicalSession]))
    localStorage.setItem('csm:config', JSON.stringify(baseConfig))
    ;(window as any).api = {
      onLibraryPatch: (callback: typeof libraryPatch) => { libraryPatch = callback },
      onProviderPatch: (callback: typeof providerPatch) => { providerPatch = callback },
      loadAllSessions: vi.fn()
        .mockImplementationOnce(() => sourceFlight)
        .mockImplementationOnce(() => refreshFlight),
      loadConfig: vi.fn(async () => structuredClone(baseConfig)),
      getSystemLocale: vi.fn(async () => 'en'),
      saveConfig: vi.fn(async () => undefined),
      onSessionAdded: vi.fn(),
      onSessionUpdated: vi.fn(),
      onSessionSummaryUpdated: vi.fn(),
      onSessionsRefresh: (callback: () => void) => { sessionsRefresh = callback },
      getActiveSessions: vi.fn(async () => []),
      onActiveSessionsChanged: vi.fn(),
      onSpotlightNavigate: vi.fn()
    }

    const { useStore } = await import('./store')
    expect(useStore.getState()).toMatchObject({
      loading: false,
      sessionBootstrapState: 'cached',
      workspaceView: 'chat'
    })
    expect(useStore.getState().sessions).toEqual([cachedProviderSession, cachedPhysicalSession])

    const initialization = useStore.getState().initialize()
    await vi.advanceTimersByTimeAsync(0)
    expect(useStore.getState().sessions).toEqual([cachedProviderSession, cachedPhysicalSession])

    providerPatch({ sessions: [], status: 'degraded' })
    resolveSource(sourceSessions)
    await initialization
    expect(useStore.getState().sessions).toHaveLength(1_501)
    expect(useStore.getState().sessions).toContainEqual(cachedProviderSession)
    expect(useStore.getState().sessions).not.toContainEqual(cachedPhysicalSession)
    expect(useStore.getState().sessionBootstrapState).toBe('degraded')

    providerPatch({ sessions: providerSessions, status: 'complete' })
    expect(useStore.getState().sessions).toHaveLength(1_510)
    expect(useStore.getState().sessions).not.toContainEqual(cachedProviderSession)
    expect(useStore.getState().sessionBootstrapState).toBe('ready')

    sessionsRefresh()
    await vi.advanceTimersByTimeAsync(500)
    providerPatch({ sessions: [], status: 'degraded' })
    resolveRefresh(sourceSessions)
    await vi.advanceTimersByTimeAsync(0)
    expect(useStore.getState().sessions).toHaveLength(1_510)
    expect(useStore.getState().sessionBootstrapState).toBe('degraded')

    providerPatch({ sessions: [], status: 'complete' })
    expect(useStore.getState().sessions).toHaveLength(1_500)
    expect(useStore.getState().sessionBootstrapState).toBe('ready')

    libraryPatch({ sessions: [cachedProviderSession] })
    expect(useStore.getState().sessions).toHaveLength(1_500)
    expect(useStore.getState().sessions).not.toContainEqual(cachedProviderSession)
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
    }), { colorScheme: 'nord' })

    resolveFirstSave(undefined)
    await Promise.all([themeSave, schemeSave])
    expect(useStore.getState().config?.preferences).toMatchObject({
      themeMode: 'dark',
      colorScheme: 'nord'
    })
  })

  it('applies per-mode color schemes and refuses routes disabled by Lens state', async () => {
    const config = {
      ...structuredClone(baseConfig),
      preferences: {
        ...structuredClone(baseConfig.preferences),
        themeMode: 'system' as const,
        colorScheme: 'default' as const,
        lightScheme: 'paper' as const,
        darkScheme: 'nord' as const,
        enabledLenses: ['audit']
      }
    }
    ;(window as any).api = {
      onLibraryPatch: vi.fn(),
      loadAllSessions: vi.fn(async () => []),
      loadConfig: vi.fn(async () => structuredClone(config)),
      getSystemLocale: vi.fn(async () => 'en'),
      saveConfig: vi.fn(async () => undefined),
      onSessionAdded: vi.fn(),
      onSessionUpdated: vi.fn(),
      onSessionSummaryUpdated: vi.fn(),
      onSessionsRefresh: vi.fn(),
      getActiveSessions: vi.fn(async () => []),
      onActiveSessionsChanged: vi.fn(),
      onSpotlightNavigate: vi.fn()
    }

    const { useStore } = await import('./store')
    await useStore.getState().initialize()

    expect(useStore.getState()).toMatchObject({ themeMode: 'system', theme: 'dark', colorScheme: 'nord' })
    useStore.getState().setThemeMode('light')
    expect(useStore.getState()).toMatchObject({ theme: 'light', colorScheme: 'paper' })
    useStore.getState().setThemeMode('dark')
    expect(useStore.getState()).toMatchObject({ theme: 'dark', colorScheme: 'nord' })

    useStore.setState({ workspaceView: 'chat' })
    useStore.getState().setWorkspaceView('insights')
    expect(useStore.getState().workspaceView).toBe('insights')
    useStore.getState().setWorkspaceView('galaxy')
    expect(useStore.getState().workspaceView).toBe('chat')
    useStore.setState({ workspaceView: 'insights' })
    useStore.getState().toggleLens('audit')
    expect(useStore.getState().workspaceView).toBe('chat')
  })

  it('materializes transcript and unavailable IPC branches without pretending they contain messages', async () => {
    const { materializeSessionDetail } = await import('./store')
    const summary = {
      id: 'visible-id',
      sessionId: 'logical-id',
      successor: 'next-id',
      filePath: '/library/session/backup.jsonl',
      slug: '',
      createdAt: '2026-07-20T00:00:00Z',
      updatedAt: '2026-07-21T00:00:00Z',
      messageCount: 4,
      turnCount: 2,
      compactCount: 0,
      cwds: [],
      version: '',
      firstUserMessage: 'hello',
      toolUsage: {},
      skillInvocations: [],
      projectPath: '',
      fileSizeBytes: 1
    } as any

    expect(materializeSessionDetail({
      fallback: 'transcript',
      transcriptMarkdown: '# Restored transcript'
    }, summary)).toMatchObject({
      id: 'visible-id',
      successor: 'next-id',
      messages: [],
      detailAvailability: 'transcript-only',
      detailFallback: 'transcript',
      transcriptMarkdown: '# Restored transcript'
    })

    expect(materializeSessionDetail({
      fallback: null,
      error: 'DETAIL_UNAVAILABLE'
    }, { ...summary, detailAvailability: 'source-recoverable' })).toMatchObject({
      messages: [],
      detailAvailability: 'source-recoverable',
      detailError: 'DETAIL_UNAVAILABLE'
    })

    expect(materializeSessionDetail({
      ...summary,
      fallback: null,
      id: 'physical-id',
      referencedFiles: [{ path: '/project/src/output.ts', actions: ['edit'], exists: true }],
      configFiles: ['/project/CLAUDE.md'],
      cwds: ['/project'],
      toolUsage: { Edit: 1 },
      skillInvocations: [{ skillName: 'audit', timestamp: '2026-07-21T00:00:00Z' }],
      userImages: ['/project/image.png'],
      pastedImageCount: 1,
      messages: [{ uuid: 'message-1' }]
    } as any, {
      ...summary,
      id: 'visible-id',
      referencedFiles: [],
      configFiles: [],
      cwds: [],
      toolUsage: {},
      skillInvocations: [],
      userImages: [],
      pastedImageCount: 0
    })).toMatchObject({
      id: 'visible-id',
      referencedFiles: [{ path: '/project/src/output.ts', actions: ['edit'], exists: true }],
      configFiles: ['/project/CLAUDE.md'],
      cwds: ['/project'],
      toolUsage: { Edit: 1 },
      userImages: ['/project/image.png'],
      pastedImageCount: 1,
      messages: [{ uuid: 'message-1' }]
    })

    expect(materializeSessionDetail({
      ...summary,
      fallback: null,
      firstUserMessage: 'ZCode 数据库中的真实标题',
      messages: [{ uuid: 'message-zcode' }]
    } as any, {
      ...summary,
      firstUserMessage: 'ZCode 会话 sess_abcd',
      isManifestOnly: true,
      manifestTitleIsFallback: true,
      detailAvailability: 'source-recoverable'
    })).toMatchObject({
      firstUserMessage: 'ZCode 数据库中的真实标题',
      detailAvailability: 'ready',
      messages: [{ uuid: 'message-zcode' }]
    })
  })

  it('replays current search query when searchIndexUpdated fires', async () => {
    let searchIndexUpdatedCb!: () => void
    const searchSessions = vi.fn(async () => [{ id: 'refreshed' }])

    ;(window as any).api = {
      onLibraryPatch: vi.fn(),
      loadAllSessions: vi.fn(async () => []),
      loadConfig: vi.fn(async () => structuredClone(baseConfig)),
      getSystemLocale: vi.fn(async () => 'en'),
      saveConfig: vi.fn(async () => undefined),
      onSessionAdded: vi.fn(),
      onSessionUpdated: vi.fn(),
      onSessionSummaryUpdated: vi.fn(),
      onSessionsRefresh: vi.fn(),
      getActiveSessions: vi.fn(async () => []),
      onActiveSessionsChanged: vi.fn(),
      onSpotlightNavigate: vi.fn(),
      onSearchIndexUpdated: (cb: () => void) => { searchIndexUpdatedCb = cb },
      searchSessions
    }

    const { useStore } = await import('./store')
    await useStore.getState().initialize()

    // Set a search query in state without triggering the full search flow
    useStore.setState({ searchQuery: 'hello', searchState: 'success' })

    // Fire the event — should replay the search
    searchIndexUpdatedCb()
    await vi.advanceTimersByTimeAsync(0)

    expect(searchSessions).toHaveBeenCalledWith('hello')
  })

  it('does not replay search when query is empty on searchIndexUpdated', async () => {
    let searchIndexUpdatedCb!: () => void
    const searchSessions = vi.fn(async () => [])

    ;(window as any).api = {
      onLibraryPatch: vi.fn(),
      loadAllSessions: vi.fn(async () => []),
      loadConfig: vi.fn(async () => structuredClone(baseConfig)),
      getSystemLocale: vi.fn(async () => 'en'),
      saveConfig: vi.fn(async () => undefined),
      onSessionAdded: vi.fn(),
      onSessionUpdated: vi.fn(),
      onSessionSummaryUpdated: vi.fn(),
      onSessionsRefresh: vi.fn(),
      getActiveSessions: vi.fn(async () => []),
      onActiveSessionsChanged: vi.fn(),
      onSpotlightNavigate: vi.fn(),
      onSearchIndexUpdated: (cb: () => void) => { searchIndexUpdatedCb = cb },
      searchSessions
    }

    const { useStore } = await import('./store')
    await useStore.getState().initialize()

    // searchQuery is '' by default — event should not trigger a search
    searchIndexUpdatedCb()
    await vi.advanceTimersByTimeAsync(0)

    expect(searchSessions).not.toHaveBeenCalled()
  })

  it('drops stale searchIndexUpdated results when query changes mid-flight', async () => {
    let searchIndexUpdatedCb!: () => void
    let resolveSearch!: (value: unknown[]) => void
    const searchSessions = vi.fn(() => new Promise<unknown[]>((resolve) => { resolveSearch = resolve }))

    ;(window as any).api = {
      onLibraryPatch: vi.fn(),
      loadAllSessions: vi.fn(async () => []),
      loadConfig: vi.fn(async () => structuredClone(baseConfig)),
      getSystemLocale: vi.fn(async () => 'en'),
      saveConfig: vi.fn(async () => undefined),
      onSessionAdded: vi.fn(),
      onSessionUpdated: vi.fn(),
      onSessionSummaryUpdated: vi.fn(),
      onSessionsRefresh: vi.fn(),
      getActiveSessions: vi.fn(async () => []),
      onActiveSessionsChanged: vi.fn(),
      onSpotlightNavigate: vi.fn(),
      onSearchIndexUpdated: (cb: () => void) => { searchIndexUpdatedCb = cb },
      searchSessions
    }

    const { useStore } = await import('./store')
    await useStore.getState().initialize()

    useStore.setState({ searchQuery: 'original', searchState: 'success' })

    // Fire the event — starts a search for 'original'
    searchIndexUpdatedCb()

    // User changes query while the IPC is in flight
    useStore.setState({ searchQuery: 'changed', searchState: 'searching' })

    // Original search resolves — results should be dropped (stale)
    resolveSearch([{ id: 'stale-result' }])
    await vi.advanceTimersByTimeAsync(0)

    expect(useStore.getState().searchResults).not.toEqual([{ id: 'stale-result' }])
    expect(useStore.getState().searchState).toBe('searching')
  })

  it('does not duplicate listeners when initialize is called twice', async () => {
    const callbacks: Array<() => void> = []
    const unsubscribe = vi.fn()
    const searchSessions = vi.fn(async () => [{ id: 'r' }])

    ;(window as any).api = {
      onLibraryPatch: vi.fn(),
      loadAllSessions: vi.fn(async () => []),
      loadConfig: vi.fn(async () => structuredClone(baseConfig)),
      getSystemLocale: vi.fn(async () => 'en'),
      saveConfig: vi.fn(async () => undefined),
      onSessionAdded: vi.fn(),
      onSessionUpdated: vi.fn(),
      onSessionSummaryUpdated: vi.fn(),
      onSessionsRefresh: vi.fn(),
      getActiveSessions: vi.fn(async () => []),
      onActiveSessionsChanged: vi.fn(),
      onSpotlightNavigate: vi.fn(),
      onSearchIndexUpdated: (cb: () => void) => { callbacks.push(cb); return unsubscribe },
      searchSessions
    }

    const { useStore } = await import('./store')
    await useStore.getState().initialize()
    await useStore.getState().initialize()

    // Second initialize should have called unsubscribe from first
    expect(unsubscribe).toHaveBeenCalledTimes(1)
    // Only the latest callback should be active
    expect(callbacks).toHaveLength(2)
  })
})
