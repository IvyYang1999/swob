import { describe, expect, it } from 'vitest'
import { builtinProviderForSource } from '../shared/provider-capabilities'
import { sessionBackupSourcePaths } from './library-manager'

describe('Provider capability snapshots match real call chains', () => {
  it('keeps physical backup and canonical provider archive capabilities distinct', () => {
    expect(sessionBackupSourcePaths({
      filePath: '/fixture/.claude/projects/project/session.jsonl'
    })).toHaveLength(1)
    expect(sessionBackupSourcePaths({
      filePath: '/fixture/.cc-mirror/projects/project/session.jsonl'
    })).toEqual([])
    expect(builtinProviderForSource('cc-mirror')?.manifest.capabilities.archive.status).toBe('unavailable')

    expect(sessionBackupSourcePaths({
      filePath: '/fixture/.gemini/antigravity-cli/brain/session/.system_generated/logs/transcript.jsonl'
    }), 'Antigravity archives canonical records rather than copying physical sources').toEqual([])
    expect(builtinProviderForSource('antigravity')?.manifest.capabilities.archive.status).toBe('available')

    const grokPath = '/fixture/.grok/sessions/project/session/chat_history.jsonl'
    expect(sessionBackupSourcePaths({ filePath: grokPath }), 'Grok source members are never copied as physical backups').toEqual([])
    expect(builtinProviderForSource('grok')?.manifest.capabilities.archive.status).toBe('available')
    const piPath = '/fixture/.pi/agent/sessions/session.jsonl'
    expect(sessionBackupSourcePaths({ filePath: piPath }), 'pi never copies source JSONL').toEqual([])
    expect(builtinProviderForSource('pi')?.manifest.capabilities.archive.status).toBe('available')
    const kimiPath = '/fixture/.kimi-code/sessions/workdir/session/agents/main/wire.jsonl'
    expect(sessionBackupSourcePaths({ filePath: kimiPath }), 'Kimi never copies source wire').toEqual([])
    expect(builtinProviderForSource('kimi')?.manifest.capabilities.archive.status).toBe('available')
    const hermesPath = '/fixture/.hermes/sessions/session.json'
    expect(sessionBackupSourcePaths({ filePath: hermesPath }), 'Hermes never copies the mutable source').toEqual([])
    expect(builtinProviderForSource('hermes')?.manifest.capabilities.archive.status).toBe('available')
  })
})
