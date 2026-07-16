/**
 * @vitest-environment jsdom
 */
import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { UpdateBanner } from './UpdateBanner'

describe('UpdateBanner', () => {
  let onAvailable: ((version: string, notes: string) => void) | undefined
  let onDownloading: ((version: string) => void) | undefined
  let onReady: ((version: string, notes: string) => void) | undefined
  const downloadUpdate = vi.fn()
  const installUpdate = vi.fn()

  beforeEach(() => {
    downloadUpdate.mockClear()
    installUpdate.mockClear()
    ;(window as any).api = {
      onUpdateAvailable: (callback: typeof onAvailable) => { onAvailable = callback },
      onUpdateDownloading: (callback: typeof onDownloading) => { onDownloading = callback },
      onUpdateReady: (callback: typeof onReady) => { onReady = callback },
      downloadUpdate,
      installUpdate
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
})
