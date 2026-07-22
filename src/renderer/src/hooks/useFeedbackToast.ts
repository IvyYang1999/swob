import { useEffect, useRef } from 'react'
import { useStore } from '../store'
import { useT } from '../i18n'

const FEEDBACK_TOAST_SEEN_KEY = 'swob:feedbackToastSeen'

/**
 * Shows a one-time toast pointing users to the feedback entry points.
 * Persists a "seen" flag in localStorage so it only fires once.
 */
export function useFeedbackToast(): void {
  const t = useT()
  const showToast = useStore((s) => s.showToast)
  const loading = useStore((s) => s.loading)
  const firedRef = useRef(false)

  useEffect(() => {
    if (loading || firedRef.current) return
    firedRef.current = true

    try {
      const seen = localStorage.getItem(FEEDBACK_TOAST_SEEN_KEY)
      if (seen) return
      localStorage.setItem(FEEDBACK_TOAST_SEEN_KEY, '1')
    } catch {
      // localStorage unavailable; skip
      return
    }

    // Small delay so the app has settled visually before the toast appears
    const timer = setTimeout(() => {
      showToast(t('toast.feedback_hint'), 'info')
    }, 3000)

    return () => clearTimeout(timer)
  }, [loading, showToast, t])
}
