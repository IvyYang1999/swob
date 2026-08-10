import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { createT211BTranslator, T211B_LOCALE_BUNDLE, T211B_TRANSLATIONS } from './translations'

const productionFiles = [
  new URL('./AgentTimeline.tsx', import.meta.url),
  new URL('./renderer-registry.ts', import.meta.url),
  new URL('../provider-doctor/ProviderDoctor.tsx', import.meta.url)
]

function consumedKeys(): string[] {
  const keys = productionFiles.flatMap((url) => {
    const source = readFileSync(fileURLToPath(url), 'utf8')
    return [...source.matchAll(/['"]((?:timeline|doctor)\.[A-Za-z.]+)['"]/g)].map((match) => match[1])
  })
  return [...new Set(keys)].sort()
}

describe('t211B feature-local translations', () => {
  it('has exact en/zh/ownedKeys parity and no unused keys', () => {
    const en = Object.keys(T211B_LOCALE_BUNDLE.en).sort()
    expect(Object.keys(T211B_LOCALE_BUNDLE.zh).sort()).toEqual(en)
    expect([...T211B_TRANSLATIONS.ownedKeys].sort()).toEqual(en)
    expect(consumedKeys()).toEqual(en)
  })

  it('keeps CJK in the locale bundle instead of visible component literals', () => {
    const productionSource = productionFiles.map((url) => readFileSync(fileURLToPath(url), 'utf8')).join('\n')
    expect(productionSource).not.toMatch(/[\u3400-\u9fff]/u)
    expect(createT211BTranslator('zh')('timeline.copy')).toBe(T211B_LOCALE_BUNDLE.zh['timeline.copy'])
    expect(createT211BTranslator('en')('timeline.copy')).toBe('Copy evidence')
  })
})
