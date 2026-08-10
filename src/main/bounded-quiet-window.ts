export function boundedQuietWindowDelay(
  firstRequestedAt: number,
  lastRequestedAt: number,
  now: number,
  quietMs: number,
  maxWaitMs: number
): number {
  const quietDelay = Math.max(0, lastRequestedAt + quietMs - now)
  const maxDelay = Math.max(0, firstRequestedAt + maxWaitMs - now)
  return Math.min(quietDelay, maxDelay)
}
