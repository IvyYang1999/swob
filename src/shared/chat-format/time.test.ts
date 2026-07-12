import { afterEach, describe, expect, it, vi } from 'vitest'
import { formatTime, formatTokenCount } from './time'

const locale = 'en-GB'
const timeOptions = { hour: '2-digit', minute: '2-digit' } as const
const dateOptions = { month: 'numeric', day: 'numeric' } as const

afterEach(() => {
  vi.useRealTimers()
})

describe('formatTime', () => {
  it('shows only HH:MM for the same local calendar day', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 6, 12, 23, 59))
    const timestamp = new Date(2026, 6, 12, 3, 4)

    expect(formatTime(timestamp.toISOString(), locale))
      .toBe(timestamp.toLocaleTimeString(locale, timeOptions))
  })

  it('adds M/D immediately across a local midnight boundary', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 6, 12, 0, 1))
    const timestamp = new Date(2026, 6, 11, 23, 59)
    const expected = `${timestamp.toLocaleDateString(locale, dateOptions)} ${timestamp.toLocaleTimeString(locale, timeOptions)}`

    expect(formatTime(timestamp.toISOString(), locale)).toBe(expected)
  })

  it('keeps the existing M/D HH:MM rule across a year boundary', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 0, 1, 0, 1))
    const timestamp = new Date(2025, 11, 31, 23, 59)
    const expected = `${timestamp.toLocaleDateString(locale, dateOptions)} ${timestamp.toLocaleTimeString(locale, timeOptions)}`

    expect(formatTime(timestamp.toISOString(), locale)).toBe(expected)
  })
})

describe('formatTokenCount', () => {
  it('formats raw, thousand, and million token counts', () => {
    expect(formatTokenCount(999)).toBe('999')
    expect(formatTokenCount(1_000)).toBe('1.0K')
    expect(formatTokenCount(1_000_000)).toBe('1.0M')
  })
})
