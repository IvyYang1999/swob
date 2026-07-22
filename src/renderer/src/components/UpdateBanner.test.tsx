/**
 * @vitest-environment jsdom
 */
import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'

vi.mock('../i18n', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../i18n')>()
  return {
    ...actual,
    useT: () => (key: string, params?: Record<string, string | number>) =>
      actual.translate('zh-CN', key, params)
  }
})

import { UpdateBanner } from './UpdateBanner'

describe('UpdateBanner', () => {
  let onAvailable: ((version: string, notes: string) => void) | undefined
  let onDownloading: ((version: string) => void) | undefined
  let onReady: ((version: string, notes: string) => void) | undefined
  let onNotAvailable: (() => void) | undefined
  let onError: ((kind: 'check' | 'download' | 'install', version: string) => void) | undefined
  const downloadUpdate = vi.fn()
  const installUpdate = vi.fn()
  const openUpdateDownloadPage = vi.fn()

  beforeEach(() => {
    downloadUpdate.mockClear()
    installUpdate.mockClear()
    openUpdateDownloadPage.mockClear()
    ;(window as any).api = {
      onUpdateAvailable: (callback: typeof onAvailable) => { onAvailable = callback },
      onUpdateDownloading: (callback: typeof onDownloading) => { onDownloading = callback },
      onUpdateReady: (callback: typeof onReady) => { onReady = callback },
      onUpdateNotAvailable: (callback: typeof onNotAvailable) => { onNotAvailable = callback },
      onUpdateError: (callback: typeof onError) => { onError = callback },
      downloadUpdate,
      installUpdate,
      openUpdateDownloadPage
    }
  })

  afterEach(() => cleanup())

  it('shows an available update, starts the requested download, then offers restart', () => {
    render(<UpdateBanner />)
    expect(screen.queryByText(/发现新版本/)).toBeNull()

    act(() => onAvailable?.('1.2.0', '- Faster sync'))
    expect(screen.getByText('发现新版本 v1.2.0')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: '更新' }))
    expect(downloadUpdate).toHaveBeenCalledTimes(1)

    act(() => onDownloading?.('1.2.0'))
    expect(screen.getByText('正在下载 v1.2.0…')).toBeTruthy()

    act(() => onReady?.('1.2.0', '- Faster sync'))
    fireEvent.click(screen.getByRole('button', { name: '重启更新' }))
    expect(installUpdate).toHaveBeenCalledTimes(1)
  })

  it('explains manual check and install failures with a safe recovery action', () => {
    render(<UpdateBanner />)

    act(() => onNotAvailable?.())
    expect(screen.getByText('当前已是最新版')).toBeTruthy()

    act(() => onError?.('check', ''))
    expect(screen.getByText('暂时无法检查更新')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '手动下载' }))
    expect(openUpdateDownloadPage).toHaveBeenCalledTimes(1)

    act(() => onError?.('download', '1.3.1'))
    expect(screen.getByText('v1.3.1 下载失败')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '重试下载' }))
    expect(downloadUpdate).toHaveBeenCalledTimes(1)
  })
})
