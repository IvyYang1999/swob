import { describe, expect, it } from 'vitest'
import type { UserConfig } from './types'
import { mergeSettingsPreferencePatch, resolveRendererConfig } from './settings-config'

const appConfig: UserConfig = {
  folders: [],
  sessionMeta: {},
  preferences: { defaultViewMode: 'compact', terminalApp: 'Terminal' }
}

describe('settings config hydration', () => {
  it('uses durable Library preferences before the Library tree is ready', () => {
    const config = resolveRendererConfig(appConfig, {
      defaultViewMode: 'full',
      terminalApp: 'iTerm2',
      legacyFixtureField: 'must-survive'
    })

    expect(config.preferences).toMatchObject({
      defaultViewMode: 'full',
      terminalApp: 'iTerm2',
      legacyFixtureField: 'must-survive'
    })
  })

  it('merges a renderer patch without discarding unknown Library fields', () => {
    const preferences = mergeSettingsPreferencePatch({
      defaultViewMode: 'compact',
      terminalApp: 'Terminal',
      legacyFixtureField: 'must-survive'
    }, {
      defaultSort: 'turns'
    })

    expect(preferences).toMatchObject({
      settingsSchemaVersion: 1,
      defaultSort: 'turns',
      legacyFixtureField: 'must-survive'
    })
  })
})
