/**
 * tF30: React hooks for Lens gating in renderer components.
 */
import { useStore } from '../store'
import { isLensEnabled as _isLensEnabled } from '../../../shared/lens-registry'

/**
 * Returns a stable function that checks if a Lens is enabled.
 * Subscribes to the relevant slice of store state.
 */
export function useLensEnabled(lensId: string): boolean {
  const preferences = useStore((state) => state.config?.preferences)
  if (!preferences) return true // no config yet = default all enabled
  return _isLensEnabled(lensId, preferences)
}
