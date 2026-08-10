export type CatalogOnboardingArchiveChoice = 'default-library' | 'index-only' | 'skip'

const previewBrand: unique symbol = Symbol('catalog-onboarding-preview')

export interface CatalogOnboardingPreviewData {
  previewId: string
  sessionCount: number
  estimatedArchiveBytes: number
  privacyScopes: string[]
  sourceCount: number
  complete: boolean
}

/** Opaque projection: UI callers cannot construct it from display literals. */
export interface CatalogOnboardingPreview extends CatalogOnboardingPreviewData {
  readonly [previewBrand]: true
}

/** @internal The main-process read-only discovery boundary is the only production caller. */
export function createCatalogOnboardingPreview(data: CatalogOnboardingPreviewData): CatalogOnboardingPreview {
  if (!data.previewId || !Number.isSafeInteger(data.sessionCount) || data.sessionCount < 0 ||
      !Number.isSafeInteger(data.estimatedArchiveBytes) || data.estimatedArchiveBytes < 0 ||
      !Number.isSafeInteger(data.sourceCount) || data.sourceCount < 1 ||
      !Array.isArray(data.privacyScopes) || data.privacyScopes.some((scope) => !scope)) throw new Error('catalog-onboarding-preview-invalid')
  return Object.freeze({ ...structuredClone(data), privacyScopes: Object.freeze([...data.privacyScopes]) as unknown as string[], [previewBrand]: true as const })
}

export function readCatalogOnboardingPreview(value: unknown): CatalogOnboardingPreviewData | undefined {
  if (!value || typeof value !== 'object' || (value as Partial<CatalogOnboardingPreview>)[previewBrand] !== true) return undefined
  const preview = value as CatalogOnboardingPreview
  return { previewId: preview.previewId, sessionCount: preview.sessionCount, estimatedArchiveBytes: preview.estimatedArchiveBytes, privacyScopes: [...preview.privacyScopes], sourceCount: preview.sourceCount, complete: preview.complete }
}
