import { describe, expect, it } from 'vitest'
import {
  defaultResumeMethodForSource,
  enabledResumeChoices,
  HARNESS_CAPABILITIES,
  harnessForSource,
  migrateSettingsPreferences
} from './settings-capabilities'
import { providerCapabilitiesForSource } from './provider-capabilities'

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

  it('未审计来源的猜测命令不能标为 stable', () => {
    for (const source of ['antigravity', 'grok', 'pi', 'hermes']) {
      const terminal = harnessForSource(source).choices.find((choice) => choice.id === 'terminal')
      expect(terminal, source).toMatchObject({
        support: 'experimental',
        reason: providerCapabilitiesForSource(source)?.['terminal-resume'].reason
      })
    }
  })

  it('Kimi --session 经来源级契约审计后标为 stable', () => {
    expect(harnessForSource('kimi').choices.find((choice) => choice.id === 'terminal')).toMatchObject({
      support: 'stable'
    })
  })

  it('CC-Mirror 不再继承 Claude Code 的 stable terminal 真相', () => {
    const mirror = harnessForSource('cc-mirror')
    expect(mirror.id).toBe('cc-mirror')
    expect(mirror.choices.find((choice) => choice.id === 'terminal')).toMatchObject({
      support: 'experimental',
      reason: providerCapabilitiesForSource('cc-mirror')?.['terminal-resume'].reason
    })
  })

  it('settings terminal/native support is projected from the Provider registry', () => {
    const support = (status: string): string => status === 'available'
      ? 'stable'
      : status === 'experimental' ? 'experimental' : 'unsupported'
    for (const harness of HARNESS_CAPABILITIES) {
      const capabilities = providerCapabilitiesForSource(harness.sourceIds[0])!
      for (const choice of harness.choices) {
        if (choice.id === 'remote-control') continue
        const declaration = choice.id === 'terminal'
          ? capabilities['terminal-resume']
          : capabilities['native-resume']
        expect(choice.support, `${harness.id}/${choice.id}`).toBe(support(declaration.status))
        expect(choice.reason, `${harness.id}/${choice.id}`).toBe(declaration.reason || undefined)
      }
    }
  })
})
