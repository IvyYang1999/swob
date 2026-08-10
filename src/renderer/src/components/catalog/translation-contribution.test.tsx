import fs from 'node:fs'
import path from 'node:path'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { ArchiveCoverage, CatalogScope, StorageRoot, StorageRootObservation } from '../../../../shared/contracts/truth-kernel'
import { CatalogNavigator, RootSettingsList } from './CatalogNavigator'
import { catalogTranslationContribution } from '../../../../shared/i18n-contributions/t211e-device-catalog'
import { WorkspaceTabs } from '../workspace-tabs/WorkspaceTabs'

const none = { status: 'unavailable', reason: 'fixture' } as const
const scope: CatalogScope = { logicalSessionIds: [], rootIds: [], collectionIds: [], providerIds: [], projectIds: [], pathPrefixes: [], timeRange: none, textQuery: none, emptyFilterSemantics: 'all-catalog' }
const root: StorageRoot = { schemaVersion: 1, rootId: 'vault', displayName: 'Fixture Vault', kind: 'obsidian-vault', capability: 'read-only', layoutPolicy: 'preserve-user-layout', includeRules: [], excludeRules: [], isDefaultArchiveTarget: false }
const observation: StorageRootObservation = { schemaVersion: 1, observationId: 'observation', rootId: 'vault', deviceId: 'fixture', permissionState: 'denied', availabilityState: 'unavailable', scanState: 'failed', lastSeenAt: none, lastSuccessfulScanAt: none, failureCode: { status: 'available', value: 'EACCES' }, observedAt: '2026-08-11T00:00:00Z' }
const coverage: ArchiveCoverage = { schemaVersion: 1, knownLogicalSessions: 3, archivedLogicalSessions: 1, sourceOnlyLogicalSessions: 1, offlineLogicalSessions: 1, conflictedLogicalSessions: 1, unavailableLogicalSessions: 0, logicalSessionIds: [], packageIds: [], offlineRootIds: ['vault'], unavailableRootIds: [], scope, scopeFingerprint: 'fixture', responseGeneration: '1', computedAt: '2026-08-11T00:00:00Z' }

describe('t211E translation contribution', () => {
  it('has exact en/zh parity, no unused owned key, and no product CJK literal outside the bundle', () => {
    const descriptor = catalogTranslationContribution
    const enKeys = Object.keys(descriptor.locales.en).sort()
    expect(Object.keys(descriptor.locales.zh).sort()).toEqual(enKeys)
    expect([...descriptor.ownedKeys].sort()).toEqual(enKeys)
    const componentPaths = [
      'src/renderer/src/components/catalog/CatalogNavigator.tsx',
      'src/renderer/src/components/workspace-tabs/WorkspaceTabs.tsx'
    ]
    const componentSource = componentPaths.map((file) => fs.readFileSync(path.join(process.cwd(), file), 'utf8')).join('\n')
    const referencedKeys = [...new Set(componentSource.match(/catalog\.[a-z0-9_.]+/g) || [])].sort()
    expect(referencedKeys).toEqual(enKeys)
    expect(componentSource).not.toMatch(/[\u3400-\u9fff]/)
  })

  it('renders real controls and all catalog states in both locales', () => {
    const common = { collections: [], roots: [{ root, observation }], sources: [], coverage, onScope: () => {}, onModeChange: () => {} }
    const en = renderToStaticMarkup(<><WorkspaceTabs tabs={[]} activeTabId="" onActivate={() => {}} onClose={() => {}} onCreate={() => {}} locale="en" /><CatalogNavigator {...common} mode="locations" locale="en" /><RootSettingsList roots={common.roots} locale="en" /></>)
    const zh = renderToStaticMarkup(<><WorkspaceTabs tabs={[]} activeTabId="" onActivate={() => {}} onClose={() => {}} onCreate={() => {}} locale="zh" /><CatalogNavigator {...common} mode="locations" locale="zh" /><RootSettingsList roots={common.roots} locale="zh" /></>)
    expect(en).toContain('Workspace tabs'); expect(en).toContain('Permission denied'); expect(en).toContain('Conflicts 1')
    expect(zh).toContain('工作区标签页'); expect(zh).toContain('权限被拒绝'); expect(zh).toContain('冲突 1')
  })
})
