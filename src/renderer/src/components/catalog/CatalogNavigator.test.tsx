/** @vitest-environment jsdom */
/// <reference types="@testing-library/jest-dom" />
import '@testing-library/jest-dom/vitest'
import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CatalogOnboarding, RootSettingsList } from './CatalogNavigator'
import { createCatalogOnboardingPreview } from '../../../../shared/catalog-onboarding-preview'
import type { StorageRoot, StorageRootObservation } from '../../../../shared/contracts/truth-kernel'

const root: StorageRoot = { schemaVersion: 1, rootId: 'vault', displayName: 'Vault', kind: 'obsidian-vault', capability: 'read-only', layoutPolicy: 'preserve-user-layout', includeRules: [], excludeRules: [], isDefaultArchiveTarget: false }
const observation: StorageRootObservation = { schemaVersion: 1, observationId: 'observation', rootId: 'vault', deviceId: 'device', permissionState: 'granted', availabilityState: 'online', scanState: 'fresh', lastSeenAt: { status: 'available', value: '2026-08-11T00:00:00Z' }, lastSuccessfulScanAt: { status: 'available', value: '2026-08-11T00:00:00Z' }, failureCode: { status: 'unavailable', reason: 'none' }, observedAt: '2026-08-11T00:00:00Z' }

afterEach(cleanup)

describe('Catalog root adoption controls', () => {
  it('requires an explicit onboarding archive choice after showing size and privacy scope', () => {
    const choose = vi.fn(); const preview = createCatalogOnboardingPreview({ previewId: 'derived', sessionCount: 10, estimatedArchiveBytes: 2 * 1024 * 1024, privacyScopes: ['root:project-folder:project'], sourceCount: 1, complete: true })
    render(<CatalogOnboarding preview={preview} onChoice={choose} />)
    expect(screen.getByText('10 sessions · about 2 MB to archive')).toBeInTheDocument(); expect(screen.getByText('Read scope: root:project-folder:project')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Index only — do not archive' })); expect(choose).toHaveBeenCalledWith('index-only', preview)
  })
  it('cannot render fabricated preview literals or an unbranded preview object', () => {
    const fabricated = { previewId: 'fake', sessionCount: 999999, estimatedArchiveBytes: 999999, privacyScopes: ['fake-secret'], sourceCount: 1, complete: true }
    const fabricatedProps = { sessionCount: 999999, estimatedArchiveBytes: 999999, privacyScopes: ['fake-secret'], preview: fabricated, onChoice: () => {} } as unknown as React.ComponentProps<typeof CatalogOnboarding>
    render(<CatalogOnboarding {...fabricatedProps} />)
    expect(screen.getByText('Run read-only discovery to calculate this preview.')).toBeInTheDocument()
    expect(screen.queryByText(/999999|fake-secret/)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Index only — do not archive' })).not.toBeInTheDocument()
  })
  it('exposes add, rescan and remove registration actions without file ownership actions', () => {
    const add = vi.fn(); const rescan = vi.fn(); const remove = vi.fn(); render(<RootSettingsList roots={[{ root, observation }]} onAdd={add} onRescan={rescan} onRemove={remove} />)
    fireEvent.click(screen.getByRole('button', { name: 'Add read-only root' })); fireEvent.click(screen.getByRole('button', { name: 'Rescan' })); fireEvent.click(screen.getByRole('button', { name: 'Remove registration' }))
    expect(add).toHaveBeenCalledOnce(); expect(rescan).toHaveBeenCalledWith('vault'); expect(remove).toHaveBeenCalledWith('vault')
  })
})
