/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TRUTH_KERNEL_GOLDEN_FIXTURE } from '../../../../shared/contracts/truth-kernel'
import { AgentTimeline } from './AgentTimeline'
import { T211B_LOCALE_BUNDLE } from './translations'

afterEach(cleanup)

describe('AgentTimeline', () => {
  it('renders canonical sequence order and keeps hidden system facts filterable', () => {
    const events = structuredClone(TRUTH_KERNEL_GOLDEN_FIXTURE.timelineEvents)
    events[0].providerEvent.visibility = 'hidden-noise'
    const first = render(<AgentTimeline events={[...events].reverse()} />)
    expect(screen.queryByText('Thinking')).toBeNull()
    expect(screen.getByText('Tool result')).toBeTruthy()

    first.unmount()
    render(<AgentTimeline events={[...events].reverse()} includeNoise />)
    const firstJump = screen.getAllByRole('button', { name: /Jump to/ })[0]
    expect(firstJump.textContent).toBe('#0')
    expect(screen.getByText('Thinking')).toBeTruthy()
  })

  it('keeps unknown evidence exportable instead of hiding it', () => {
    const onExport = vi.fn()
    render(<AgentTimeline events={TRUTH_KERNEL_GOLDEN_FIXTURE.timelineEvents} onExport={onExport} />)
    expect(screen.getAllByText(/Unknown event: future\.quantum-event/)).toHaveLength(1)
    fireEvent.click(screen.getAllByRole('button', { name: 'Export reference' }).at(-1)!)
    expect(onExport).toHaveBeenCalledWith(expect.objectContaining({ providerEvent: expect.objectContaining({ kind: 'unknown' }) }))
  })

  it('renders controls and event labels from the zh locale bundle', () => {
    render(<AgentTimeline events={TRUTH_KERNEL_GOLDEN_FIXTURE.timelineEvents} locale="zh" />)
    expect(screen.getByLabelText(T211B_LOCALE_BUNDLE.zh['timeline.label'])).toBeTruthy()
    expect(screen.getByText(T211B_LOCALE_BUNDLE.zh['timeline.thinking'])).toBeTruthy()
    expect(screen.getAllByRole('button', { name: T211B_LOCALE_BUNDLE.zh['timeline.export'] }).length).toBeGreaterThan(0)
  })

  it('renders dedicated historical question, response, permission and subagent cards', () => {
    const events = structuredClone(TRUTH_KERNEL_GOLDEN_FIXTURE.timelineEvents)
    const spawn = structuredClone(events[0])
    spawn.timelineEventId = 'timeline-subagent'
    spawn.sequence = 100
    spawn.providerEvent = { ...spawn.providerEvent, id: 'subagent', sequence: 100, kind: 'subagent.spawn', actor: 'assistant', payload: { agentId: 'child-1', parentAgentId: 'root-1' } }
    render(<AgentTimeline events={[...events, spawn]} />)
    expect(document.querySelector('[data-specialized-card="question"]')).toBeTruthy()
    expect(document.querySelector('[data-specialized-card="response"]')).toBeTruthy()
    expect(document.querySelectorAll('[data-specialized-card="permission"]')).toHaveLength(2)
    expect(document.querySelector('[data-specialized-card="subagent"]')?.textContent).toContain('child-1')
    expect(screen.getByText('Historical request — read only')).toBeTruthy()
  })

  it('supports live free-form questions and permission decisions accessibly', () => {
    const events = structuredClone(TRUTH_KERNEL_GOLDEN_FIXTURE.timelineEvents)
    const question = events.find((entry) => entry.providerEvent.kind === 'interaction.request')!
    question.providerEvent.payload = { requestId: 'live-question', prompt: 'Explain', options: [], multiSelect: false, state: { state: 'live-pending', channelId: 'channel', expiresAt: null }, toolCallId: null, rawInput: {} }
    const permission = events.find((entry) => entry.providerEvent.kind === 'permission.request')!
    permission.providerEvent.payload = { requestId: 'live-permission', permission: 'write', resource: { path: 'document.txt' }, state: { state: 'live-pending', channelId: 'channel', expiresAt: null }, toolCallId: null, rawInput: {} }
    const onInteractionResponse = vi.fn()
    const onPermissionResponse = vi.fn()
    render(<AgentTimeline events={[question, permission]} onInteractionResponse={onInteractionResponse} onPermissionResponse={onPermissionResponse} />)
    fireEvent.change(screen.getByRole('textbox', { name: /Your answer/ }), { target: { value: 'Because' } })
    fireEvent.click(screen.getByRole('button', { name: 'Submit answer' }))
    fireEvent.click(screen.getByRole('button', { name: 'Deny' }))
    expect(onInteractionResponse).toHaveBeenCalledWith('live-question', ['Because'])
    expect(onPermissionResponse).toHaveBeenCalledWith('live-permission', 'deny')
  })

  it('keeps same-sequence input order stable and reports search anchors', () => {
    const events = structuredClone(TRUTH_KERNEL_GOLDEN_FIXTURE.timelineEvents.slice(0, 2))
    events[1].sequence = events[0].sequence
    events[1].providerEvent.sequence = events[0].providerEvent.sequence
    const onSearchMatches = vi.fn()
    render(<AgentTimeline events={[events[1], events[0]]} searchQuery="Read" onSearchMatches={onSearchMatches} />)
    expect(screen.getAllByRole('button', { name: /Jump to/ }).map((button) => button.closest('article')?.dataset.timelineKind)).toEqual(['tool-call', 'thinking'])
    expect(onSearchMatches).toHaveBeenLastCalledWith([events[1].timelineEventId])
  })

  it('virtualizes a 1500-event session instead of mounting every card', () => {
    const template = TRUTH_KERNEL_GOLDEN_FIXTURE.timelineEvents[0]
    const events = Array.from({ length: 1500 }, (_, index) => ({
      ...structuredClone(template),
      timelineEventId: `large-${index}`,
      sourceEventId: `large-provider-${index}`,
      sequence: index,
      providerEvent: { ...structuredClone(template.providerEvent), id: `large-provider-${index}`, sequence: index }
    }))
    const started = performance.now()
    const { container } = render(<AgentTimeline events={events} />)
    expect(container.querySelector('[data-virtualized="true"]')).toBeTruthy()
    expect(container.querySelectorAll('[data-timeline-kind]').length).toBeLessThan(100)
    expect(performance.now() - started).toBeLessThan(1000)
  })
})
