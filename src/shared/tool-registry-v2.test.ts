import { describe, expect, it } from 'vitest'
import { createBuiltinToolRegistryV2 } from './tool-registry-v2'

describe('Provider v2 三层工具注册表', () => {
  it('raw alias 经 semantic tool 到 presentation，交互升级不依赖 renderer 字符串分支', () => {
    const registry = createBuiltinToolRegistryV2()
    const question = registry.resolve({
      providerId: 'swob/claude-code',
      formatVersion: 'claude-jsonl-v1',
      rawName: 'AskUserQuestion',
      callId: 'call:q',
      input: { question: 'Choose one', options: ['A', 'B'] }
    })
    expect(question).toMatchObject({
      semanticToolId: 'interaction.question',
      eventKind: 'interaction.request',
      presentation: { component: 'interaction-card' }
    })

    const permission = registry.resolve({
      providerId: 'swob/claude-code',
      formatVersion: 'claude-jsonl-v1',
      rawName: 'RequestPermissions',
      callId: 'call:p',
      input: { permission: 'filesystem.write' }
    })
    expect(permission).toMatchObject({ semanticToolId: 'permission.request', eventKind: 'permission.request' })

    const unknown = registry.resolve({
      providerId: 'example/future',
      formatVersion: 'future-v9',
      rawName: 'UnseenTool',
      callId: 'call:u',
      input: { future: true }
    })
    expect(unknown).toMatchObject({
      semanticToolId: 'tool.unknown',
      eventKind: 'tool.call',
      normalizedInput: { future: true },
      presentation: { component: 'generic-tool-card' }
    })
  })
})
