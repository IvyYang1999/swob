export interface RuntimeCleanupStep {
  name: string
  timeoutMs?: number
  run: () => void | Promise<void>
}

export interface RuntimeCleanupResult {
  durationMs: number
  timedOut: boolean
  steps: Array<{ name: string; durationMs: number; outcome: 'ok' | 'error' | 'timeout' }>
}

interface RuntimeCleanupOptions {
  totalBudgetMs?: number
  log?: (event: string, fields: Record<string, unknown>) => void
}

function runWithDeadline(action: () => void | Promise<void>, timeoutMs: number): Promise<'ok' | 'error' | 'timeout'> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (outcome: 'ok' | 'error' | 'timeout'): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(outcome)
    }
    const timer = setTimeout(() => finish('timeout'), Math.max(0, timeoutMs))
    Promise.resolve()
      .then(action)
      .then(() => finish('ok'))
      .catch(() => finish('error'))
  })
}

export async function runRuntimeCleanup(
  steps: RuntimeCleanupStep[],
  options: RuntimeCleanupOptions = {}
): Promise<RuntimeCleanupResult> {
  const startedAt = Date.now()
  const budgetMs = options.totalBudgetMs ?? 1_800
  const results: RuntimeCleanupResult['steps'] = []
  let timedOut = false

  options.log?.('cleanup-start', { budgetMs })
  for (const step of steps) {
    const elapsed = Date.now() - startedAt
    const remaining = budgetMs - elapsed
    if (remaining <= 0) {
      timedOut = true
      results.push({ name: step.name, durationMs: 0, outcome: 'timeout' })
      options.log?.('cleanup-step', { name: step.name, durationMs: 0, outcome: 'timeout' })
      continue
    }
    const stepStartedAt = Date.now()
    const outcome = await runWithDeadline(step.run, Math.min(remaining, step.timeoutMs ?? remaining))
    const durationMs = Date.now() - stepStartedAt
    if (outcome === 'timeout') timedOut = true
    results.push({ name: step.name, durationMs, outcome })
    options.log?.('cleanup-step', { name: step.name, durationMs, outcome })
  }

  const durationMs = Date.now() - startedAt
  options.log?.('cleanup-complete', { durationMs, timedOut })
  return { durationMs, timedOut, steps: results }
}
