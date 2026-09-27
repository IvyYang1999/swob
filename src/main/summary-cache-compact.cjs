// One usage copy of the compact column (token-accounting.ts CompactUsageEventRollup,
// summary-cache v31). Since F1m it keeps the billing identity usage-facts derives
// (dedupKey and billingFactKey apart, the timestamp, the auditSourceId): a load
// decides cross-session ownership on read, from cached summaries too, and ranks
// copies by it. Ownership itself is never cached.
function usageEventRollup(event) {
  const components = event.components
  return [
    event.dedupKey,
    event.billingFactKey || null,
    event.scope,
    event.provenance,
    components.nonCachedInputTokens,
    components.cacheReadTokens,
    components.cacheWriteTokens,
    components.cacheWrite5mTokens,
    components.cacheWrite1hTokens,
    components.outputTokens,
    components.reasoningTokens || 0,
    event.timestamp || null,
    event.auditSourceId || null
  ]
}

function compactTokenAccounting(accounting) {
  const {
    usageEvents,
    usageEventsOmitted: _usageEventsOmitted,
    usageEventRollups,
    ...aggregate
  } = accounting
  const source = Array.isArray(usageEventRollups)
    ? usageEventRollups
    : Array.isArray(usageEvents) ? usageEvents.map(usageEventRollup) : []
  return { ...aggregate, usageEventRollups: source }
}

function compactPerFileJson(perFile) {
  return JSON.stringify(perFile, function (_key, value) {
    return value && typeof value === 'object' && value.metricVersion === 2
      ? compactTokenAccounting(value)
      : value
  })
}

module.exports = { compactPerFileJson }
