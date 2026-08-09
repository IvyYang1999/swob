/**
 * @vitest-environment jsdom
 */
/// <reference types="@testing-library/jest-dom" />
import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { createInitializingLibraryHealthSnapshot } from '../../../shared/library-health-contract'

const health = createInitializingLibraryHealthSnapshot()

vi.mock('../hooks/useLibraryHealth', () => ({
  useLibraryHealth: () => health
}))

vi.mock('../i18n', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../i18n')>()
  return {
    ...actual,
    useT: () => (key: string, params?: Record<string, string | number>) =>
      actual.translate('zh-CN', key, params)
  }
})

import { StaleDisclaimer } from './LibraryFreshnessIndicators'

describe('StaleDisclaimer', () => {
  afterEach(() => cleanup())

  it('身份冲突不等于数据过期：active source durable 时不显示免责声明', () => {
    health.state = 'identity-conflict'
    health.dimensions.activeSourceFreshness.state = 'durable'
    health.diagnostics = [{
      schemaVersion: 1,
      timestamp: '2026-08-09T00:00:00.000Z',
      state: 'identity-conflict',
      errorCode: 'IDENTITY_CONFLICT',
      message: 'identity conflict',
      severity: 'warning'
    }]

    render(<StaleDisclaimer variant="search" />)

    expect(screen.queryByText('搜索数据可能不是最新的')).toBeNull()
  })

  it('只有 active source freshness 未被证明时才显示上下文免责声明', () => {
    health.state = 'ready'
    health.dimensions.activeSourceFreshness.state = 'unverifiable'
    health.diagnostics = []

    render(<StaleDisclaimer variant="search" />)

    expect(screen.getByText('搜索数据可能不是最新的')).not.toBeNull()
  })
})
