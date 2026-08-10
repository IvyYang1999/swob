import { useVirtualizer } from '@tanstack/react-virtual'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { AgentTimelineEvent } from '../../../../shared/contracts/truth-kernel'
import type { JsonValue } from '../../../../shared/provider-schema-v2.generated'
import { persistedOutputSummary, renderTimelineEvent } from './renderer-registry'
import { createT211BTranslator, type T211BLocale, type T211BTranslator } from './translations'

export interface AgentTimelineProps {
  events: readonly AgentTimelineEvent[]
  /** System/context facts remain exportable even when this defaults to false. */
  includeNoise?: boolean
  onExport?: (event: AgentTimelineEvent) => void
  onAnchor?: (eventId: string) => void
  onInteractionResponse?: (requestId: string, answers: string[]) => void
  onPermissionResponse?: (requestId: string, decision: 'allow' | 'deny') => void
  searchQuery?: string
  onSearchMatches?: (eventIds: string[]) => void
  locale?: T211BLocale
  virtualizeThreshold?: number
}

function eventTime(event: AgentTimelineEvent, t: T211BTranslator): string {
  return event.providerEvent.timestamp ?? t('timeline.sequence', { sequence: event.sequence })
}

async function copyEvidence(event: AgentTimelineEvent): Promise<void> {
  await navigator.clipboard?.writeText(JSON.stringify(event.providerEvent, null, 2))
}

function record(value: JsonValue): Record<string, JsonValue> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, JsonValue> : {}
}

function string(value: JsonValue | undefined): string {
  return typeof value === 'string' ? value : ''
}

function QuestionCard({ event, t, onResponse }: { event: AgentTimelineEvent; t: T211BTranslator; onResponse?: (requestId: string, answers: string[]) => void }) {
  const payload = record(event.providerEvent.payload)
  const requestId = string(payload.requestId)
  const options = Array.isArray(payload.options) ? payload.options.map(record) : []
  const state = record(payload.state)
  const live = state.state === 'live-pending'
  const multi = payload.multiSelect === true
  const [selected, setSelected] = useState<string[]>([])
  const [freeForm, setFreeForm] = useState('')
  const answer = (value: string) => setSelected((current) => multi
    ? current.includes(value) ? current.filter((item) => item !== value) : [...current, value]
    : [value])
  return <div className="mt-2 space-y-2" data-specialized-card="question">
    <p className="whitespace-pre-wrap text-sm text-secondary">{string(payload.prompt)}</p>
    {options.length > 0 && <div className="flex flex-wrap gap-2" role="group" aria-label={t('timeline.question.options')}>
      {options.map((option, index) => {
        const label = string(option.label)
        const active = selected.includes(label)
        return <button key={`${string(option.id)}:${index}`} type="button" disabled={!live} aria-pressed={active} onClick={() => answer(label)} className={`rounded border px-2 py-1 text-xs ${active ? 'border-soft-purple bg-soft-purple/15' : 'border-edge/60'} disabled:opacity-60`}>
          {label}<span className="block text-muted">{string(option.description)}</span>
        </button>
      })}
    </div>}
    {options.length === 0 && <label className="block text-xs text-muted">{t('timeline.question.freeForm')}<input value={freeForm} disabled={!live} onChange={(input) => setFreeForm(input.target.value)} className="mt-1 w-full rounded border border-edge/60 bg-surface px-2 py-1 text-primary" /></label>}
    {live && <button type="button" disabled={options.length > 0 ? selected.length === 0 : !freeForm.trim()} onClick={() => onResponse?.(requestId, options.length > 0 ? selected : [freeForm.trim()])} className="rounded bg-soft-purple px-2 py-1 text-xs text-white disabled:opacity-50">{t('timeline.question.submit')}</button>}
    {!live && <span className="text-xs text-muted">{t('timeline.question.historical')}</span>}
  </div>
}

function ResponseCard({ event, t }: { event: AgentTimelineEvent; t: T211BTranslator }) {
  const payload = record(event.providerEvent.payload)
  const answers = Array.isArray(payload.answers) ? payload.answers.map(string) : []
  return <div className="mt-2 flex flex-wrap gap-2" data-specialized-card="response" aria-label={t('timeline.response.answers')}>
    {answers.map((answer, index) => <span key={`${answer}:${index}`} className="rounded-full bg-surface px-2 py-1 text-xs text-secondary">{answer}</span>)}
    {answers.length === 0 && <span className="text-xs text-muted">{string(payload.outcome)}</span>}
  </div>
}

function PermissionCard({ event, t, onResponse }: { event: AgentTimelineEvent; t: T211BTranslator; onResponse?: (requestId: string, decision: 'allow' | 'deny') => void }) {
  const payload = record(event.providerEvent.payload)
  const state = record(payload.state)
  const live = event.providerEvent.kind === 'permission.request' && state.state === 'live-pending'
  return <div className="mt-2 rounded border border-amber-500/30 bg-amber-500/5 p-2" data-specialized-card="permission">
    <div className="text-xs text-secondary">{event.providerEvent.kind === 'permission.response' ? string(payload.decision) : JSON.stringify(payload.resource, null, 2)}</div>
    {live && <div className="mt-2 flex gap-2"><button type="button" onClick={() => onResponse?.(string(payload.requestId), 'allow')} className="rounded bg-emerald-600 px-2 py-1 text-xs text-white">{t('timeline.permission.allow')}</button><button type="button" onClick={() => onResponse?.(string(payload.requestId), 'deny')} className="rounded bg-red-600 px-2 py-1 text-xs text-white">{t('timeline.permission.deny')}</button></div>}
  </div>
}

function SubagentCard({ event, t }: { event: AgentTimelineEvent; t: T211BTranslator }) {
  const payload = record(event.providerEvent.payload)
  return <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-2 text-xs" data-specialized-card="subagent"><dt className="text-muted">{t('timeline.subagent.agent')}</dt><dd className="font-mono text-secondary">{string(payload.agentId)}</dd><dt className="text-muted">{t('timeline.subagent.parent')}</dt><dd className="font-mono text-secondary">{string(payload.parentAgentId)}</dd></dl>
}

function TimelineEventCard({ event, t, isExpanded, onToggle, onExport, onAnchor, onInteractionResponse, onPermissionResponse }: {
  event: AgentTimelineEvent
  t: T211BTranslator
  isExpanded: boolean
  onToggle: () => void
  onExport?: (event: AgentTimelineEvent) => void
  onAnchor?: (eventId: string) => void
  onInteractionResponse?: (requestId: string, answers: string[]) => void
  onPermissionResponse?: (requestId: string, decision: 'allow' | 'deny') => void
}) {
  const model = renderTimelineEvent(event.providerEvent, t)
  const canCollapse = Boolean(model.detail && model.detail.length > 420)
  const specialized = event.providerEvent.kind === 'interaction.request'
    ? <QuestionCard event={event} t={t} onResponse={onInteractionResponse} />
    : event.providerEvent.kind === 'interaction.response'
      ? <ResponseCard event={event} t={t} />
      : event.providerEvent.kind === 'permission.request' || event.providerEvent.kind === 'permission.response'
        ? <PermissionCard event={event} t={t} onResponse={onPermissionResponse} />
        : event.providerEvent.kind === 'subagent.spawn'
          ? <SubagentCard event={event} t={t} />
          : null
  return <article id={`timeline-${event.timelineEventId}`} className="rounded-lg border border-edge/60 bg-surface/30 p-3" data-timeline-kind={model.card}>
    <div className="flex min-w-0 items-center gap-2 text-xs">
      <button type="button" onClick={() => onAnchor?.(event.timelineEventId)} className="font-mono text-muted hover:text-primary focus-visible:outline focus-visible:outline-2" aria-label={t('timeline.jump', { eventId: event.timelineEventId })}>#{event.sequence}</button>
      <strong className="truncate text-secondary">{model.title}</strong>
      <time className="ml-auto shrink-0 text-muted">{eventTime(event, t)}</time>
    </div>
    {specialized ?? (model.detail && <pre className={`mt-2 max-h-96 overflow-x-auto overflow-y-auto whitespace-pre-wrap break-words rounded bg-surface/60 p-2 text-xs text-secondary ${canCollapse && !isExpanded ? 'max-h-28 overflow-y-hidden' : ''}`}>{model.detail}</pre>)}
    {canCollapse && !specialized && <button type="button" onClick={onToggle} aria-expanded={isExpanded} className="mt-2 text-xs text-soft-purple hover:underline focus-visible:outline focus-visible:outline-2">{isExpanded ? t('timeline.collapse') : t('timeline.expand')}</button>}
    {event.persistedOutputs.map((output) => <div key={output.artifactId} className="mt-2 min-w-0 rounded border border-edge/40 px-2 py-1 text-xs text-muted" data-content-state={output.contentState} data-active-content="blocked">
      <strong>{t('timeline.persistedOutput')}</strong><span className="ml-1 break-all">{persistedOutputSummary(output, t)}</span>
    </div>)}
    <div className="mt-2 flex gap-3 text-xs">
      {model.copyable && <button type="button" onClick={() => void copyEvidence(event)} className="text-soft-purple hover:underline focus-visible:outline focus-visible:outline-2">{t('timeline.copy')}</button>}
      {model.exportable && <button type="button" onClick={() => onExport?.(event)} className="text-soft-purple hover:underline focus-visible:outline focus-visible:outline-2">{t('timeline.export')}</button>}
    </div>
  </article>
}

/** Native-v2 read view: one provider event remains one stable timeline item. */
export function AgentTimeline({ events, includeNoise = false, onExport, onAnchor, onInteractionResponse, onPermissionResponse, searchQuery = '', onSearchMatches, locale = 'en', virtualizeThreshold = 200 }: AgentTimelineProps) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const scrollRef = useRef<HTMLDivElement>(null)
  const t = useMemo(() => createT211BTranslator(locale), [locale])
  const ordered = useMemo(() => events
    .map((entry, inputIndex) => ({ entry, inputIndex }))
    .filter(({ entry }) => includeNoise || entry.providerEvent.visibility !== 'hidden-noise')
    .sort((left, right) => left.entry.sequence - right.entry.sequence || left.inputIndex - right.inputIndex)
    .map(({ entry }) => entry), [events, includeNoise])
  const normalizedQuery = searchQuery.trim().toLocaleLowerCase()
  const matchIds = useMemo(() => normalizedQuery ? ordered.filter((event) => JSON.stringify(event.providerEvent).toLocaleLowerCase().includes(normalizedQuery)).map((event) => event.timelineEventId) : [], [normalizedQuery, ordered])
  useEffect(() => onSearchMatches?.(matchIds), [matchIds, onSearchMatches])
  const virtualized = ordered.length >= virtualizeThreshold
  const virtualizer = useVirtualizer({
    count: virtualized ? ordered.length : 0,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 180,
    overscan: normalizedQuery ? 12 : 4,
    getItemKey: (index) => ordered[index]?.timelineEventId ?? index
  })
  const toggle = (eventId: string) => setExpanded((current) => {
    const next = new Set(current)
    next.has(eventId) ? next.delete(eventId) : next.add(eventId)
    return next
  })
  const card = (event: AgentTimelineEvent) => <TimelineEventCard event={event} t={t} isExpanded={expanded.has(event.timelineEventId)} onToggle={() => toggle(event.timelineEventId)} onExport={onExport} onAnchor={onAnchor} onInteractionResponse={onInteractionResponse} onPermissionResponse={onPermissionResponse} />

  if (!virtualized) return <ol aria-label={t('timeline.label')} className="space-y-2 overflow-x-hidden">{ordered.map((event) => <li key={event.timelineEventId}>{card(event)}</li>)}</ol>
  return <div ref={scrollRef} className="max-h-[70vh] overflow-y-auto overflow-x-hidden" data-virtualized="true">
    <ol aria-label={t('timeline.label')} className="relative" style={{ height: virtualizer.getTotalSize() }}>
      {virtualizer.getVirtualItems().map((row) => <li key={row.key} ref={virtualizer.measureElement} data-index={row.index} className="absolute left-0 top-0 w-full pb-2" style={{ transform: `translateY(${row.start}px)` }}>{card(ordered[row.index])}</li>)}
    </ol>
  </div>
}
