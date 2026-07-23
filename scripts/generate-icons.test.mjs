import { describe, expect, it } from 'vitest'
import { toManifestPath } from './generate-icons.mjs'

describe('brand icon manifest paths', () => {
  it('normalizes Windows separators to the portable manifest format', () => {
    expect(toManifestPath('build\\brand\\swob-logo-session-galaxy.png')).toBe(
      'build/brand/swob-logo-session-galaxy.png'
    )
    expect(toManifestPath('build\\icon.icns')).toBe('build/icon.icns')
  })

  it('preserves already-portable paths', () => {
    expect(toManifestPath('build/icon.png')).toBe('build/icon.png')
  })
})
