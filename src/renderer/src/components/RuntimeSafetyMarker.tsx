export function RuntimeSafetyMarker({ floating = false }: { floating?: boolean }) {
  const state = window.api.runtimeGetSafetyState()
  if (!state.dangerousRealLibrary || !state.marker) return null

  return (
    <div
      data-testid="real-library-danger-marker"
      role="status"
      aria-label="Danger: development build using real Library"
      title="Development build is using the real Library via SWOB_DEV_USE_REAL_LIBRARY=1"
      className={[
        'select-none whitespace-nowrap rounded border border-red-300 bg-red-600 px-2 py-1',
        'text-[10px] font-bold tracking-[0.08em] text-white shadow-sm',
        floating ? 'fixed left-1/2 top-2 z-[100] -translate-x-1/2' : 'shrink-0'
      ].join(' ')}
    >
      {state.marker}
    </div>
  )
}
