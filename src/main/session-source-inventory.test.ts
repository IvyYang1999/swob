import { describe, expect, it } from 'vitest'
import { SessionSourceInventory } from './session-source-inventory'
import type { SessionSummary } from './types'

function session(id: string, source: SessionSummary['source'], updatedAt: string): SessionSummary {
  return {
    id,
    sessionId: id,
    slug: id,
    createdAt: updatedAt,
    updatedAt,
    messageCount: 0,
    turnCount: 0,
    compactCount: 0,
    cwds: [],
    version: '',
    firstUserMessage: '',
    toolUsage: {},
    skillInvocations: [],
    projectPath: '',
    filePath: '',
    fileSizeBytes: 0,
    userImages: [],
    pastedImageCount: 0,
    tokenUsage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0
    },
    referencedFiles: [],
    configFiles: [],
    source
  }
}

const isProvider = (value: SessionSummary): boolean => value.source === 'pi'

describe('SessionSourceInventory', () => {
  it('keeps excluded source sessions available for a later retry', () => {
    const inventory = new SessionSourceInventory(isProvider)
    const claude = session('claude', 'claude-code', '2026-08-10T09:00:00.000Z')
    const codex = session('codex', 'codex', '2026-08-10T10:00:00.000Z')
    inventory.replacePhysical([claude, codex])

    expect(inventory.filtered(['claude-code']).map((item) => item.id)).toEqual(['codex'])
    expect(inventory.filtered([]).map((item) => item.id)).toEqual(['codex', 'claude'])
  })

  it('replaces authoritative provider results without deleting physical sessions', () => {
    const inventory = new SessionSourceInventory(isProvider)
    const physical = session('physical', 'codex', '2026-08-10T08:00:00.000Z')
    const oldProvider = session('provider-old', 'pi', '2026-08-10T09:00:00.000Z')
    const newProvider = session('provider-new', 'pi', '2026-08-10T10:00:00.000Z')
    inventory.replacePhysical([physical])
    inventory.merge([oldProvider])

    inventory.replaceProviders([newProvider])

    expect(inventory.snapshot().map((item) => item.id)).toEqual(['provider-new', 'physical'])
  })

  it('merges degraded provider results as last-known-good additions', () => {
    const inventory = new SessionSourceInventory(isProvider)
    const oldProvider = session('provider-old', 'pi', '2026-08-10T09:00:00.000Z')
    const partialProvider = session('provider-partial', 'pi', '2026-08-10T10:00:00.000Z')
    inventory.replaceProviders([oldProvider])

    inventory.merge([partialProvider])

    expect(inventory.snapshot().map((item) => item.id)).toEqual([
      'provider-partial',
      'provider-old'
    ])
  })

  it('removes a live continuation child after it is folded into its parent', () => {
    const inventory = new SessionSourceInventory(isProvider)
    const parent = session('parent', 'claude-code', '2026-08-10T09:00:00.000Z')
    const continuation = session('continuation', 'claude-code', '2026-08-10T10:00:00.000Z')
    inventory.replacePhysical([parent])
    inventory.merge([continuation])

    inventory.remove([continuation.id])
    inventory.merge([{ ...parent, updatedAt: continuation.updatedAt }])

    expect(inventory.snapshot().map((item) => item.id)).toEqual(['parent'])
  })
})
