/** @vitest-environment jsdom */
/// <reference types="@testing-library/jest-dom" />
import '@testing-library/jest-dom/vitest'
import React from 'react'
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import type { WorkspaceTab } from '../../../../shared/contracts/truth-kernel'
import { WorkspaceTabs } from './WorkspaceTabs'

const tab = (tabId: string, title: string, pinned = false): WorkspaceTab => ({ schemaVersion: 1, tabId, title, scope: { logicalSessionIds: [], rootIds: [], collectionIds: [], providerIds: [], projectIds: [], pathPrefixes: [], timeRange: { status: 'unavailable', reason: 'all-time' }, textQuery: { status: 'unavailable', reason: 'none' }, emptyFilterSemantics: 'all-catalog' }, view: 'sessions', sidebarMode: 'collections', selectedObjectId: { status: 'unavailable', reason: 'none' }, filters: {}, sort: { status: 'unavailable', reason: 'default' }, navigationHistory: [], scrollState: { anchorObjectId: { status: 'unavailable', reason: 'none' }, offsetPx: 0 }, layoutState: { density: 'comfortable', inspectorOpen: false, splitRatio: { status: 'unavailable', reason: 'none' } }, pinned, persisted: true })

describe('WorkspaceTabs', () => {
  it('keeps long labels scrollable, exposes focusable tab and close controls', () => {
    const activate = vi.fn(); const close = vi.fn(); const create = vi.fn()
    render(<WorkspaceTabs tabs={[tab('all', '全部会话 · Insights', true), tab('vault', 'A very long Obsidian Vault scope label that must truncate')]} activeTabId="all" onActivate={activate} onClose={close} onCreate={create} />)
    expect(screen.getByTestId('workspace-tab-strip')).toHaveClass('overflow-x-auto')
    expect(screen.getByRole('tab', { name: '全部会话 · Insights' })).toHaveAttribute('aria-current', 'page')
    fireEvent.click(screen.getByRole('button', { name: 'Close A very long Obsidian Vault scope label that must truncate' }))
    fireEvent.click(screen.getByRole('button', { name: 'New workspace tab' }))
    expect(close).toHaveBeenCalledWith('vault'); expect(create).toHaveBeenCalledOnce()
  })

  it('uses the feature locale bundle for Chinese controls', () => {
    render(<WorkspaceTabs tabs={[tab('all', '全部会话')]} activeTabId="all" onActivate={() => {}} onClose={() => {}} onCreate={() => {}} locale="zh" />)
    expect(screen.getByRole('navigation', { name: '工作区标签页' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '关闭 全部会话' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '新建工作区标签页' })).toBeInTheDocument()
  })

  it('supports roving keyboard activation plus pin, duplicate, rename and restore controls', () => {
    const activate = vi.fn(); const pin = vi.fn(); const duplicate = vi.fn(); const rename = vi.fn(); const restore = vi.fn()
    render(<WorkspaceTabs tabs={[tab('all', 'All', true), tab('vault', 'Vault')]} activeTabId="vault" onActivate={activate} onClose={() => {}} onCreate={() => {}} onPin={pin} onDuplicate={duplicate} onRename={rename} onRestoreRecentlyClosed={restore} />)
    fireEvent.keyDown(screen.getByRole('tab', { name: 'All' }), { key: 'ArrowRight' })
    expect(activate).toHaveBeenCalledWith('vault')
    fireEvent.doubleClick(screen.getByRole('tab', { name: 'Vault' }))
    fireEvent.click(screen.getByRole('button', { name: 'Pin Vault' }))
    fireEvent.click(screen.getByRole('button', { name: 'Duplicate Vault' }))
    fireEvent.click(screen.getByRole('button', { name: 'Restore recently closed tab' }))
    expect(rename).toHaveBeenCalledWith('vault'); expect(pin).toHaveBeenCalledWith('vault', true); expect(duplicate).toHaveBeenCalledWith('vault'); expect(restore).toHaveBeenCalledOnce()
  })
})
