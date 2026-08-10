import { describe, expect, it } from 'vitest'
import { TRUTH_KERNEL_GOLDEN_FIXTURE } from '../../../../shared/contracts/truth-kernel'
import { renderTimelineEvent, T211B_TIMELINE_RENDERER_REGISTRY } from './renderer-registry'

describe('t211B AgentTimeline registry', () => {
  it('maps every frozen golden event without silently dropping it', () => {
    for (const entry of TRUTH_KERNEL_GOLDEN_FIXTURE.timelineEvents) {
      const card = renderTimelineEvent(entry.providerEvent)
      expect(card.card).toBe(T211B_TIMELINE_RENDERER_REGISTRY[entry.providerEvent.kind])
      expect(card.exportable).toBe(true)
    }
  })

  it('keeps future provider events as explicit, exportable Unknown cards', () => {
    const unknown = TRUTH_KERNEL_GOLDEN_FIXTURE.timelineEvents.find((entry) => entry.providerEvent.kind === 'unknown')!
    const card = renderTimelineEvent(unknown.providerEvent)
    expect(card.card).toBe('unknown')
    expect(card.title).toContain('future.quantum-event')
    expect(card.detail).toContain('preserved')
  })
})
