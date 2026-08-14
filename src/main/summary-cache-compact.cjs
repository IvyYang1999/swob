function usageEventRollup(event) {
  const components = event.components
  return [
    event.billingFactKey || event.dedupKey,
    event.scope,
    event.provenance,
    components.nonCachedInputTokens,
    components.cacheReadTokens,
    components.cacheWriteTokens,
    components.cacheWrite5mTokens,
    components.cacheWrite1hTokens,
    components.outputTokens,
    components.reasoningTokens || 0
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
