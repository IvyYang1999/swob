import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

describe('renderer i18n literals', () => {
  it('contains no CJK literals outside the reviewed allowlist', () => {
    const result = spawnSync(process.execPath, ['scripts/check-i18n-literals.mjs'], {
      cwd: process.cwd(),
      encoding: 'utf8'
    })
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0)
  })
})
