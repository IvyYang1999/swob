import {
  resolveBootstrapLibraryCandidate,
  runtimeSafetyState,
  type RuntimeSafetyState
} from './e2e-library-isolation'

/**
 * This module is imported before Electron and every write-capable Swob module.
 * A thrown error therefore terminates an unsafe process before app/config paths
 * can be initialized or repaired.
 */
export const startupRuntimeSafety: RuntimeSafetyState = runtimeSafetyState(
  resolveBootstrapLibraryCandidate(process.env),
  process.env
)

process.env.SWOB_RUNTIME_SAFETY_MODE = startupRuntimeSafety.mode

if (startupRuntimeSafety.dangerousRealLibrary) {
  console.error(
    '[runtime-safety] DANGER: development build is using the real Library; ' +
    'explicit SWOB_DEV_USE_REAL_LIBRARY=1 override is active.'
  )
}
