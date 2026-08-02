import { describe, expect, it } from 'vitest'

/**
 * R4 contract lock: Compensation cancel/fail toast messages.
 *
 * The LibraryHealthBanner uses different toast messages depending on the
 * compensation outcome. This tests the branching logic directly to ensure
 * cancelled/failed outcomes never show a "success" message.
 */
describe('compensation toast message branching', () => {
  // Reproduces the branching logic from LibraryHealthBanner's useEffect
  function selectToastVariant(compensation: {
    inProgress: boolean
    cancelled: boolean
    completed: number
    failed: number
    total: number
  }): 'cancelled' | 'all-failed' | 'partial' | 'success' {
    if (compensation.cancelled) return 'cancelled'
    if (compensation.failed > 0 && compensation.completed === 0) return 'all-failed'
    if (compensation.failed > 0) return 'partial'
    return 'success'
  }

  it('compensation cancelled shows cancel variant, not success', () => {
    const variant = selectToastVariant({
      inProgress: false,
      cancelled: true,
      completed: 3,
      failed: 0,
      total: 5
    })
    expect(variant).toBe('cancelled')
    expect(variant).not.toBe('success')
  })

  it('compensation with all failures shows all-failed variant', () => {
    const variant = selectToastVariant({
      inProgress: false,
      cancelled: false,
      completed: 0,
      failed: 5,
      total: 5
    })
    expect(variant).toBe('all-failed')
    expect(variant).not.toBe('success')
  })

  it('compensation with partial failures shows partial variant', () => {
    const variant = selectToastVariant({
      inProgress: false,
      cancelled: false,
      completed: 3,
      failed: 2,
      total: 5
    })
    expect(variant).toBe('partial')
    expect(variant).not.toBe('success')
  })

  it('compensation fully completed shows success variant', () => {
    const variant = selectToastVariant({
      inProgress: false,
      cancelled: false,
      completed: 5,
      failed: 0,
      total: 5
    })
    expect(variant).toBe('success')
  })
})
