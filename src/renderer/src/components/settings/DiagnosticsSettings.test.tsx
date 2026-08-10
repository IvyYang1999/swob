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
      libraryCancelDuplicateRecoveryAnalysis: vi.fn().mockResolvedValue(true),
      libraryApplyDuplicateRecovery: vi.fn(),
      onDuplicateRecoveryProgress: vi.fn(() => vi.fn())
    }
  })

  afterEach(() => cleanup())

  it('普通模式不混加不同单位，并自动启动只读身份分析', async () => {
    render(<DiagnosticsSettings />)

    expect(screen.getByText('正在核验 12 组会话身份冲突')).not.toBeNull()
    expect(screen.getByText('发现 12 组会话身份冲突。分析不会修改 Library。')).not.toBeNull()
    expect(screen.getByText('另有 2 组已确认的历史重复包，以只读方式保留。')).not.toBeNull()
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
    expect(screen.getByText(/有独有内容的包绝不会自动移动/)).not.toBeNull()
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
    let finishApply!: (value: { appliedPackageCount: number; restartRequired: boolean }) => void
    const applyPromise = new Promise<{ appliedPackageCount: number; restartRequired: boolean }>((resolve) => {
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
      finishApply({ appliedPackageCount: 2, restartRequired: false })
      await waitFor(() => expect(showToast).toHaveBeenCalledTimes(1))
    } finally {
      confirm.mockRestore()
    }
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
