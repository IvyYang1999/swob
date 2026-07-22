import { describe, expect, it } from 'vitest'
import { preferredSystemLanguagesForRuntime } from './runtime-locale'

describe('preferredSystemLanguagesForRuntime', () => {
  it('uses a deterministic locale only inside an explicit E2E home', () => {
    expect(preferredSystemLanguagesForRuntime(['en-US'], {
      NODE_ENV: 'test',
      SWOB_TEST_HOME: '/tmp/swob-e2e',
      SWOB_TEST_LOCALE: 'zh-CN'
    })).toEqual(['zh-CN'])
  })

  it('ignores locale overrides outside the isolated test runtime', () => {
    expect(preferredSystemLanguagesForRuntime(['en-US'], {
      NODE_ENV: 'production',
      SWOB_TEST_HOME: '/tmp/swob-e2e',
      SWOB_TEST_LOCALE: 'zh-CN'
    })).toEqual(['en-US'])
    expect(preferredSystemLanguagesForRuntime(['en-US'], {
      NODE_ENV: 'test',
      SWOB_TEST_LOCALE: 'zh-CN'
    })).toEqual(['en-US'])
  })
})
