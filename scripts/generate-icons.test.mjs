import { execFileSync } from 'node:child_process'
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

  it('pins hash-bound SVG checkouts to LF on every platform', () => {
    const attributes = execFileSync(
      'git',
      ['check-attr', 'text', 'eol', '--', 'site/assets/favicon.svg'],
      { encoding: 'utf8' }
    )
    expect(attributes).toContain('text: set')
    expect(attributes).toContain('eol: lf')
  })
})
