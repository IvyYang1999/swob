import { describe, expect, it } from 'vitest'
import {
  defaultResumeMethodForSource,
  enabledResumeChoices,
  HARNESS_CAPABILITIES,
  harnessForSource,
  migrateSettingsPreferences
} from './settings-capabilities'

describe('设置偏好迁移与 Resume 能力', () => {
  it('旧 iTerm 配置自动迁移，同时保留未知旧字段', () => {
    const migrated = migrateSettingsPreferences({
      terminalApp: 'iTerm2',
      resumeTerminal: 'iterm',
      projectViewMode: 'paths'
    })

    expect(migrated.defaultTerminalId).toBe('iterm2')
    expect(migrated.projectViewMode).toBe('paths')
    expect(migrated.defaultSort).toBe('updated')
    expect(migrated.autoCheckUpdates).toBe(true)
    expect(migrated.resumeMethodByHarness.codex).toBe('codex-desktop')
  })

  it('Claude Desktop 未显式开启时不进入可选默认方式', () => {
    const claude = harnessForSource('claude-code')
    expect(enabledResumeChoices(claude, false).map((choice) => choice.id)).toEqual([
      'terminal', 'remote-control'
    ])
    expect(defaultResumeMethodForSource({
      resumeMethodByHarness: { 'claude-code': 'claude-desktop' }
    }, 'claude-code')).toBe('terminal')
  })

  it('按来源返回真实默认：Codex 桌面直达，ZCode 只打开 App', () => {
    expect(defaultResumeMethodForSource({}, 'codex')).toBe('codex-desktop')
    expect(defaultResumeMethodForSource({}, 'zcode')).toBe('zcode-desktop')
    expect(defaultResumeMethodForSource({}, 'cursor')).toBe('terminal')
  })

  it('每个 harness 的默认方式都必须出现在稳定或实验能力声明中', () => {
    for (const harness of HARNESS_CAPABILITIES) {
      const choice = harness.choices.find((item) => item.id === harness.defaultMethod)
      expect(choice, harness.id).toBeDefined()
      expect(choice?.support).not.toBe('unsupported')
    }
  })
})
