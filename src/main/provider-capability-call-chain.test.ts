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

    const paths: Record<string, string> = {
      antigravity: '/fixture/.gemini/antigravity/session.json',
      grok: '/fixture/.grok/sessions/session.jsonl',
      hermes: '/fixture/.hermes/sessions/session.json'
    }
    for (const [source, filePath] of Object.entries(paths)) {
      expect(sessionBackupSourcePaths({ filePath }), source).toEqual([])
      expect(builtinProviderForSource(source)?.manifest.capabilities.archive.status, source).toBe('unavailable')
    }
    const piPath = '/fixture/.pi/agent/sessions/session.jsonl'
    expect(sessionBackupSourcePaths({ filePath: piPath }), 'pi never copies source JSONL').toEqual([])
    expect(builtinProviderForSource('pi')?.manifest.capabilities.archive.status).toBe('available')
    const kimiPath = '/fixture/.kimi-code/sessions/workdir/session/agents/main/wire.jsonl'
    expect(sessionBackupSourcePaths({ filePath: kimiPath }), 'Kimi never copies source wire').toEqual([])
    expect(builtinProviderForSource('kimi')?.manifest.capabilities.archive.status).toBe('available')
  })
})
