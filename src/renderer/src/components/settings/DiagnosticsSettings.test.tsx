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
health.availableActions = ['retry-compensation']
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

  it('普通模式只统计可操作问题，不把历史来源桶和已授权只读组冒充故障', () => {
    render(<DiagnosticsSettings />)

    expect(screen.getByText('有 14 项需要处理')).not.toBeNull()
    expect(screen.getByText('发现 12 组会话身份冲突。分析不会修改 Library。')).not.toBeNull()
    expect(screen.getByText('另有 2 组已确认的历史重复包，以只读方式保留。')).not.toBeNull()
    expect(screen.queryByTestId('diagnostics-raw')).toBeNull()
    expect(screen.queryByText(/missing-source/)).toBeNull()
    expect(screen.queryByText(/remote-session/)).toBeNull()
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

  it('安全分析只返回脱敏汇总，并把自动隔离与人工合并边界分开', async () => {
    render(<DiagnosticsSettings />)
    fireEvent.click(screen.getByRole('button', { name: '安全分析' }))

    await waitFor(() => expect((window as any).api.libraryAnalyzeDuplicateRecovery).toHaveBeenCalledTimes(1))
    expect(await screen.findByTestId('duplicate-recovery-result')).not.toBeNull()
    expect(screen.getByText('2')).not.toBeNull()
    expect(screen.getByRole('button', { name: '隔离 2 个等价副本' })).not.toBeNull()
    expect(screen.getByText(/有独有内容的包绝不会自动移动/)).not.toBeNull()
  })
})
