export interface EpochBoundTaskOptions {
  epoch: number
  currentEpoch: () => number
  isPaused: () => boolean
  isStopped: () => boolean
  run: () => void
}

/** Defer work without letting a timer from a replaced runtime revive it. */
export function scheduleEpochBoundTask(options: EpochBoundTaskOptions): NodeJS.Timeout {
  const timer = setTimeout(() => {
    if (options.isStopped() || options.isPaused() || options.currentEpoch() !== options.epoch) return
    options.run()
  }, 0)
  timer.unref?.()
  return timer
}
