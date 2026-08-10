/**
 * @vitest-environment jsdom
 */
/// <reference types="@testing-library/jest-dom" />
import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createInitializingLibraryHealthSnapshot } from '../../../../shared/library-health-contract'

const savePreferences = vi.fn().mockResolvedValue(undefined)
const showToast = vi.fn()
const mockStore: any = {
  config: { preferences: { defaultViewMode: 'compact', terminalApp: 'Terminal', debugMode: false } },
  savePreferences,
  showToast,
  sessionBootstrapState: 'degraded'
}
const health = createInitializingLibraryHealthSnapshot()
health.state = 'identity-conflict'
health.writeCapability = 'partial'
health.availableActions = []
health.dimensions.writerCapability.state = 'available'
health.dimensions.activeSourceFreshness.state = 'durable'
health.dimensions.backgroundBacklog = {
  ...health.dimensions.backgroundBacklog,
  state: 'completed-with-errors',
  total: 440,
  completed: 438,
  failed: 2,
  remaining: 0,
  failureCounts: { SESSION_SYNC_FAILED: 2 },
  unverifiableBuckets: {
    'missing-source': 294,
    'icloud-placeholder': 0,
    'remote-session': 25,
    'corrupt-manifest': 0,
    other: 0
  }
}
health.dimensions.identityExceptions = {
  ...health.dimensions.identityExceptions,
  state: 'evidence-mismatch',
  authorizedGroupCount: 2,
  authorizedPackageCount: 11,
  unknownGroupCount: 11,
  unknownPackageCount: 63,
  evidenceMismatchGroupCount: 1
}

vi.mock('../../store', () => ({
  useStore: (selector?: (state: typeof mockStore) => unknown) => selector ? selector(mockStore) : mockStore
}))

vi.mock('../../hooks/useLibraryHealth', () => ({
  useLibraryHealth: () => health,
  retryCompensation: vi.fn().mockResolvedValue(true)
}))

vi.mock('../../i18n', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../i18n')>()
  return {
    ...actual,
    useT: () => (key: string, params?: Record<string, string | number>) =>
      actual.translate('zh-CN', key, params)
  }
})

import { DiagnosticsSettings } from './DiagnosticsSettings'

describe('DiagnosticsSettings', () => {
  beforeEach(() => {
    savePreferences.mockClear()
    showToast.mockClear()
    mockStore.config.preferences.debugMode = false
    ;(window as any).api = {
      libraryAnalyzeDuplicateRecovery: vi.fn().mockResolvedValue({
        schemaVersion: 1,
        planId: 'plan:0123456789abcdef01234567',
        packageCount: 2001,
        conflictCount: 14,
        autoRepairableGroupCount: 1,
        autoRepairablePackageCount: 2,
        manualMergeGroupCount: 3,
        preservedGroupCount: 10
      }),
      libraryGetCachedDuplicateRecoverySummary: vi.fn().mockResolvedValue(null),
      libraryCancelDuplicateRecoveryAnalysis: vi.fn().mockResolvedValue(true),
      libraryApplyDuplicateRecovery: vi.fn(),
      onDuplicateRecoveryProgress: vi.fn(() => vi.fn())
    }
  })

  afterEach(() => cleanup())

  it('普通模式不混加不同单位，并自动启动只读身份分析', async () => {
    render(<DiagnosticsSettings />)

    expect(screen.getByText('正在比对 12 组重复会话')).not.toBeNull()
    expect(screen.getByText(/这不代表原始会话文件丢失/)).not.toBeNull()
    expect(screen.getByText('另有 2 组历史重复包已确认保留，不需要处理。')).not.toBeNull()
    expect(screen.queryByTestId('diagnostics-raw')).toBeNull()
    expect(screen.queryByText(/missing-source/)).toBeNull()
    expect(screen.queryByText(/remote-session/)).toBeNull()
    await waitFor(() => expect((window as any).api.libraryAnalyzeDuplicateRecovery).toHaveBeenCalledTimes(1))
  })

  it('Debug Mode 默认关闭并通过偏好显式启用，即使外部 store 尚未回写也立即可用', () => {
    render(<DiagnosticsSettings />)
    const toggle = screen.getByRole('checkbox', { name: 'Debug Mode' })
    expect((toggle as HTMLInputElement).checked).toBe(false)

    fireEvent.click(toggle)

    expect(savePreferences).toHaveBeenCalledWith({ debugMode: true })
    expect((toggle as HTMLInputElement).checked).toBe(true)
    expect(screen.getByTestId('diagnostics-raw').textContent).toContain('"sessionBootstrapState": "degraded"')
  })

  it('安全停止或恢复耗尽时只说无法写入，不谎称仍在自动恢复', () => {
    const previousState = health.state
    const previousWriterRecovery = health.writerRecovery
    health.state = 'read-only'
    health.writerRecovery = { attempt: 0, nextRetryAt: null, lastReason: null }
    try {
      render(<DiagnosticsSettings />)
      expect(screen.getByText('Library 暂时无法写入')).not.toBeNull()
      expect(screen.queryByText('Library 暂时受保护，Swob 正在自动恢复')).toBeNull()
    } finally {
      health.state = previousState
      health.writerRecovery = previousWriterRecovery
    }
  })

  it('显式 Debug Mode 才展示原始状态、错误码和历史桶', () => {
    mockStore.config.preferences.debugMode = true
    render(<DiagnosticsSettings />)

    const raw = screen.getByTestId('diagnostics-raw')
    expect(raw.textContent).toContain('completed-with-errors')
    expect(raw.textContent).toContain('SESSION_SYNC_FAILED')
    expect(raw.textContent).toContain('missing-source')
    expect(raw.textContent).toContain('remote-session')
  })

  it('自动只读分析返回脱敏汇总，并把自动隔离与人工合并边界分开', async () => {
    render(<DiagnosticsSettings />)

    await waitFor(() => expect((window as any).api.libraryAnalyzeDuplicateRecovery).toHaveBeenCalledTimes(1))
    expect(await screen.findByTestId('duplicate-recovery-result')).not.toBeNull()
    expect(screen.getByText('2')).not.toBeNull()
    expect(screen.getByRole('button', { name: '隔离 2 个等价副本' })).not.toBeNull()
    expect(screen.getByText(/任何含不同内容的包都会原样保留/)).not.toBeNull()
  })

  it('重启后先展示脱敏缓存但禁止应用，当前复核完成后才开放隔离', async () => {
    let finishAnalysis!: (value: any) => void
    const live = new Promise((resolve) => { finishAnalysis = resolve })
    ;(window as any).api.libraryAnalyzeDuplicateRecovery.mockReturnValue(live)
    ;(window as any).api.libraryGetCachedDuplicateRecoverySummary.mockResolvedValue({
      schemaVersion: 1,
      planId: 'plan:fedcba9876543210fedcba98',
      completedAt: '2026-08-09T00:00:00.000Z',
      canApply: false,
      packageCount: 20,
      conflictCount: 1,
      autoRepairableGroupCount: 1,
      autoRepairablePackageCount: 2,
      manualMergeGroupCount: 0,
      preservedGroupCount: 0
    })

    render(<DiagnosticsSettings />)
    expect(await screen.findByText(/这是上次只读分析的脱敏汇总/)).not.toBeNull()
    expect(screen.getByRole('button', { name: '取消分析' })).not.toBeNull()
    expect(screen.queryByRole('button', { name: '隔离 2 个等价副本' })).toBeNull()

    finishAnalysis({
      schemaVersion: 1,
      planId: 'plan:0123456789abcdef01234567',
      completedAt: '2026-08-10T00:00:00.000Z',
      canApply: true,
      packageCount: 20,
      conflictCount: 1,
      autoRepairableGroupCount: 1,
      autoRepairablePackageCount: 2,
      manualMergeGroupCount: 0,
      preservedGroupCount: 0
    })
    expect(await screen.findByRole('button', { name: '隔离 2 个等价副本' })).not.toBeNull()
  })

  it('取消发生在缓存晚到之前时，历史汇总仍明确显示为已暂停', async () => {
    let finishAnalysis!: (value: any) => void
    let finishCache!: (value: any) => void
    ;(window as any).api.libraryAnalyzeDuplicateRecovery.mockReturnValue(
      new Promise((resolve) => { finishAnalysis = resolve })
    )
    ;(window as any).api.libraryGetCachedDuplicateRecoverySummary.mockReturnValue(
      new Promise((resolve) => { finishCache = resolve })
    )

    render(<DiagnosticsSettings />)
    fireEvent.click(await screen.findByRole('button', { name: '取消分析' }))
    finishCache({
      schemaVersion: 1,
      planId: 'plan:fedcba9876543210fedcba98',
      completedAt: '2026-08-09T00:00:00.000Z',
      canApply: false,
      packageCount: 20,
      conflictCount: 1,
      autoRepairableGroupCount: 1,
      autoRepairablePackageCount: 2,
      manualMergeGroupCount: 0,
      preservedGroupCount: 0
    })

    expect(await screen.findByText(/当前复核已暂停/)).not.toBeNull()
    expect(screen.getByText('只读分析已暂停；Library 没有被修改。')).not.toBeNull()
    expect(screen.getByText('12 组重复会话的只读比对已暂停')).not.toBeNull()
    expect(screen.queryByText(/Swob 正在按当前 Library 重新核验/)).toBeNull()
    expect(screen.queryByRole('button', { name: '隔离 2 个等价副本' })).toBeNull()
    finishAnalysis(null)
  })

  it('当前复核失败时，缓存只作历史展示且不谎称仍在核验', async () => {
    ;(window as any).api.libraryAnalyzeDuplicateRecovery.mockRejectedValue(new Error('failed'))
    ;(window as any).api.libraryGetCachedDuplicateRecoverySummary.mockResolvedValue({
      schemaVersion: 1,
      planId: 'plan:fedcba9876543210fedcba98',
      completedAt: '2026-08-09T00:00:00.000Z',
      canApply: false,
      packageCount: 20,
      conflictCount: 1,
      autoRepairableGroupCount: 1,
      autoRepairablePackageCount: 2,
      manualMergeGroupCount: 0,
      preservedGroupCount: 0
    })

    render(<DiagnosticsSettings />)
    expect(await screen.findByText(/当前复核未完成/)).not.toBeNull()
    expect(screen.getByText('分析未完成，Library 没有被修改')).not.toBeNull()
    expect(screen.getByText('12 组重复会话尚未比对完成')).not.toBeNull()
    expect(screen.queryByText(/Swob 正在按当前 Library 重新核验/)).toBeNull()
    expect(screen.queryByRole('button', { name: '隔离 2 个等价副本' })).toBeNull()
  })

  it('用户暂停只读分析后给出明确恢复入口，不会停在无按钮状态', async () => {
    let finishAnalysis!: (value: any) => void
    const pendingAnalysis = new Promise((resolve) => { finishAnalysis = resolve })
    const analyze = (window as any).api.libraryAnalyzeDuplicateRecovery
    analyze.mockReset().mockReturnValueOnce(pendingAnalysis).mockResolvedValueOnce({
      schemaVersion: 1,
      planId: 'plan:0123456789abcdef01234567',
      packageCount: 20,
      conflictCount: 1,
      autoRepairableGroupCount: 0,
      autoRepairablePackageCount: 0,
      manualMergeGroupCount: 1,
      preservedGroupCount: 0
    })

    render(<DiagnosticsSettings />)
    fireEvent.click(await screen.findByRole('button', { name: '取消分析' }))

    await waitFor(() => expect((window as any).api.libraryCancelDuplicateRecoveryAnalysis).toHaveBeenCalledTimes(1))
    expect(screen.getByText('只读分析已暂停；Library 没有被修改。')).not.toBeNull()
    expect(screen.getByText('12 组重复会话的只读比对已暂停')).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '重新分析' }))
    await waitFor(() => expect(analyze).toHaveBeenCalledTimes(2))

    finishAnalysis({
      schemaVersion: 1,
      planId: 'plan:fedcba9876543210fedcba98',
      packageCount: 20,
      conflictCount: 1,
      autoRepairableGroupCount: 1,
      autoRepairablePackageCount: 9,
      manualMergeGroupCount: 0,
      preservedGroupCount: 0
    })
  })

  it('Library inventory generation 改变时清掉旧结论并重新读取主进程分析', async () => {
    const previousGeneration = health.dimensions.identityExceptions.analysisGeneration
    const view = render(<DiagnosticsSettings />)
    try {
      await waitFor(() => expect((window as any).api.libraryAnalyzeDuplicateRecovery).toHaveBeenCalledTimes(1))
      health.dimensions.identityExceptions.analysisGeneration = 'next-root:42'
      view.rerender(<DiagnosticsSettings />)
      await waitFor(() => expect((window as any).api.libraryAnalyzeDuplicateRecovery).toHaveBeenCalledTimes(2))
    } finally {
      health.dimensions.identityExceptions.analysisGeneration = previousGeneration
    }
  })

  it('只允许最新 generation 的异步分析更新界面', async () => {
    let rejectOld!: (error: Error) => void
    let resolveNew!: (value: any) => void
    const oldPromise = new Promise((_resolve, reject) => { rejectOld = reject })
    const newPromise = new Promise((resolve) => { resolveNew = resolve })
    const analyze = (window as any).api.libraryAnalyzeDuplicateRecovery
    analyze.mockReset().mockReturnValueOnce(oldPromise).mockReturnValueOnce(newPromise)
    const previousGeneration = health.dimensions.identityExceptions.analysisGeneration
    const view = render(<DiagnosticsSettings />)
    try {
      await waitFor(() => expect(analyze).toHaveBeenCalledTimes(1))
      health.dimensions.identityExceptions.analysisGeneration = 'new-generation:43'
      view.rerender(<DiagnosticsSettings />)
      await waitFor(() => expect(analyze).toHaveBeenCalledTimes(2))
      resolveNew({
        schemaVersion: 1,
        planId: 'plan:0123456789abcdef01234567',
        packageCount: 20,
        conflictCount: 1,
        autoRepairableGroupCount: 1,
        autoRepairablePackageCount: 2,
        manualMergeGroupCount: 0,
        preservedGroupCount: 0
      })
      expect(await screen.findByRole('button', { name: '隔离 2 个等价副本' })).not.toBeNull()
      rejectOld(new Error('superseded'))
      await waitFor(() => expect(screen.queryByText('分析未完成，Library 没有被修改')).toBeNull())
      expect(screen.queryByRole('button', { name: '隔离 9 个等价副本' })).toBeNull()
    } finally {
      health.dimensions.identityExceptions.analysisGeneration = previousGeneration
    }
  })

  it('一次确认在重渲染前连续点击也只提交一次应用', async () => {
    let finishApply!: (value: {
      schemaVersion: 1
      status: 'applied'
      planId: string
      appliedPackageCount: number
      restartRequired: boolean
    }) => void
    const applyPromise = new Promise<Parameters<typeof finishApply>[0]>((resolve) => {
      finishApply = resolve
    })
    ;(window as any).api.libraryApplyDuplicateRecovery.mockReturnValue(applyPromise)
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    try {
      render(<DiagnosticsSettings />)
      const button = await screen.findByRole('button', { name: '隔离 2 个等价副本' })
      fireEvent.click(button)
      fireEvent.click(button)
      expect(confirm).toHaveBeenCalledTimes(1)
      expect((window as any).api.libraryApplyDuplicateRecovery).toHaveBeenCalledTimes(1)
      finishApply({
        schemaVersion: 1,
        status: 'applied',
        planId: 'plan:0123456789abcdef01234567',
        appliedPackageCount: 2,
        restartRequired: false
      })
      await waitFor(() => expect(showToast).toHaveBeenCalledTimes(1))
    } finally {
      confirm.mockRestore()
    }
  })

  it('计划过期时立即移除旧按钮并加入主进程的重新分析', async () => {
    const analyze = (window as any).api.libraryAnalyzeDuplicateRecovery
    let finishReanalysis!: (value: any) => void
    const pendingReanalysis = new Promise((resolve) => { finishReanalysis = resolve })
    analyze.mockResolvedValueOnce({
      schemaVersion: 1,
      planId: 'plan:0123456789abcdef01234567',
      packageCount: 20,
      conflictCount: 1,
      autoRepairableGroupCount: 1,
      autoRepairablePackageCount: 2,
      manualMergeGroupCount: 0,
      preservedGroupCount: 0
    }).mockReturnValueOnce(pendingReanalysis)
    ;(window as any).api.libraryApplyDuplicateRecovery.mockResolvedValue({
      schemaVersion: 1,
      status: 'stale',
      planId: 'plan:0123456789abcdef01234567',
      appliedPackageCount: 0,
      restartRequired: false
    })
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    try {
      render(<DiagnosticsSettings />)
      fireEvent.click(await screen.findByRole('button', { name: '隔离 2 个等价副本' }))
      await waitFor(() => expect(analyze).toHaveBeenCalledTimes(2))
      expect(screen.queryByRole('button', { name: '隔离 2 个等价副本' })).toBeNull()
      expect(showToast).toHaveBeenCalledWith(
        'Library 已发生变化，旧操作已取消；Swob 正在重新检查。',
        'info'
      )
    } finally {
      finishReanalysis({
        schemaVersion: 1,
        planId: 'plan:fedcba9876543210fedcba98',
        packageCount: 20,
        conflictCount: 1,
        autoRepairableGroupCount: 0,
        autoRepairablePackageCount: 0,
        manualMergeGroupCount: 1,
        preservedGroupCount: 0
      })
      confirm.mockRestore()
    }
  })

  it('卸载设置页只解除进度订阅，不取消主进程分析或接受晚到结果', async () => {
    let finishOld!: (value: any) => void
    let finishNew!: (value: any) => void
    const oldPromise = new Promise((resolve) => { finishOld = resolve })
    const newPromise = new Promise((resolve) => { finishNew = resolve })
    const analyze = (window as any).api.libraryAnalyzeDuplicateRecovery
    analyze.mockReset().mockReturnValueOnce(oldPromise).mockReturnValueOnce(newPromise)
    const unsubscribeOld = vi.fn()
    const unsubscribeNew = vi.fn()
    ;(window as any).api.onDuplicateRecoveryProgress
      .mockReturnValueOnce(unsubscribeOld)
      .mockReturnValueOnce(unsubscribeNew)

    const first = render(<DiagnosticsSettings />)
    await waitFor(() => expect(analyze).toHaveBeenCalledTimes(1))
    first.unmount()
    expect(unsubscribeOld).toHaveBeenCalledTimes(1)
    expect((window as any).api.libraryCancelDuplicateRecoveryAnalysis).not.toHaveBeenCalled()

    const second = render(<DiagnosticsSettings />)
    await waitFor(() => expect(analyze).toHaveBeenCalledTimes(2))
    finishNew({
      schemaVersion: 1,
      planId: 'plan:0123456789abcdef01234567',
      packageCount: 20,
      conflictCount: 1,
      autoRepairableGroupCount: 1,
      autoRepairablePackageCount: 2,
      manualMergeGroupCount: 0,
      preservedGroupCount: 0
    })
    expect(await screen.findByRole('button', { name: '隔离 2 个等价副本' })).not.toBeNull()
    finishOld({
      schemaVersion: 1,
      planId: 'plan:fedcba9876543210fedcba98',
      packageCount: 20,
      conflictCount: 1,
      autoRepairableGroupCount: 1,
      autoRepairablePackageCount: 9,
      manualMergeGroupCount: 0,
      preservedGroupCount: 0
    })
    await waitFor(() => expect(screen.queryByRole('button', { name: '隔离 9 个等价副本' })).toBeNull())
    expect(unsubscribeOld).toHaveBeenCalledTimes(1)
    expect((window as any).api.libraryCancelDuplicateRecoveryAnalysis).not.toHaveBeenCalled()
    second.unmount()
  })

  it('临时失败由系统自动排期，普通模式不提供无意义的手动重跑', () => {
    const previous = health.dimensions.backgroundBacklog
    health.dimensions.backgroundBacklog = {
      ...previous,
      recovery: {
        state: 'scheduled',
        retryScheduled: 7,
        waitingProvider: 0,
        attentionRequired: 0,
        exhausted: 0,
        maxAttempts: 5,
        nextRetryAt: '2026-08-10T00:00:00.000Z'
      }
    }
    try {
      render(<DiagnosticsSettings />)
      expect(screen.getByText('7 个临时失败已排入自动重试；无需手动操作。')).not.toBeNull()
      expect(screen.queryByRole('button', { name: '重新补齐' })).toBeNull()
    } finally {
      health.dimensions.backgroundBacklog = previous
    }
  })
})
