import { describe, expect, it } from 'vitest'
import { toManifestPath } from './generate-icons.mjs'

describe('brand icon manifest paths', () => {
  it('normalizes Windows separators to the portable manifest format', () => {
    expect(toManifestPath('build\\brand\\swob-logo-session-galaxy.png')).toBe(
      'build/brand/swob-logo-session-galaxy.png'
    )
    expect(toManifestPath('website\\public\\favicon.svg')).toBe('website/public/favicon.svg')
  })

  it('preserves already-portable paths', () => {
    expect(toManifestPath('site/assets/favicon-512.png')).toBe('site/assets/favicon-512.png')
  })
})
