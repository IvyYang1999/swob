import { createHash } from 'node:crypto'
import type { StorageRoot } from '../../shared/contracts/truth-kernel'
import { createCatalogOnboardingPreview, type CatalogOnboardingPreview } from '../../shared/catalog-onboarding-preview'
import { scanStorageRootReadOnly, type ReadOnlyRootScanOptions, type ReadOnlyRootScanResult } from './root-scanner'

export interface OnboardingCandidateRoot {
  root: StorageRoot
  localPath: string
}

export interface OnboardingDiscoveryResult {
  preview?: CatalogOnboardingPreview
  scans: Array<{ rootId: string; result: ReadOnlyRootScanResult }>
}

/** Read-only candidate discovery and mechanical preview derivation. */
export function discoverCatalogOnboarding(candidates: OnboardingCandidateRoot[], deviceId: string, options: ReadOnlyRootScanOptions = {}): OnboardingDiscoveryResult {
  if (candidates.length === 0) return { scans: [] }
  const scans = candidates.map(({ root, localPath }) => ({ rootId: root.rootId, root, result: scanStorageRootReadOnly(root, localPath, deviceId, new Date().toISOString(), options) }))
  const successful = scans.filter((scan) => scan.result.observation.availabilityState === 'online')
  if (successful.length === 0) return { scans: scans.map(({ rootId, result }) => ({ rootId, result })) }
  const sessionSizes = new Map<string, number>()
  const privacyScopes = new Set<string>()
  for (const scan of successful) {
    privacyScopes.add(`root:${scan.root.kind}:${scan.root.rootId}`)
    for (const entry of scan.result.entries) {
      sessionSizes.set(entry.session.logicalSessionId, Math.max(sessionSizes.get(entry.session.logicalSessionId) ?? 0, entry.estimatedArchiveBytes))
      for (const providerId of entry.metadata.providerIds) privacyScopes.add(`provider:${providerId}`)
    }
  }
  const fingerprintInput = successful.map((scan) => ({ rootId: scan.rootId, complete: scan.result.complete, checkpoints: scan.result.checkpoints.map((item) => [item.relativePath, item.digest, item.logicalSessionId, item.estimatedArchiveBytes]) })).sort((a, b) => a.rootId.localeCompare(b.rootId))
  const preview = createCatalogOnboardingPreview({
    previewId: createHash('sha256').update(JSON.stringify(fingerprintInput)).digest('hex'),
    sessionCount: sessionSizes.size,
    estimatedArchiveBytes: [...sessionSizes.values()].reduce((sum, size) => sum + size, 0),
    privacyScopes: [...privacyScopes].sort(),
    sourceCount: successful.length,
    complete: successful.length === scans.length && successful.every((scan) => scan.result.complete)
  })
  return { preview, scans: scans.map(({ rootId, result }) => ({ rootId, result })) }
}
