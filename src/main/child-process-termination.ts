import type { ChildProcess } from 'node:child_process'

interface TerminationOptions {
  graceMs?: number
  killWaitMs?: number
}

function hasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (hasExited(child)) return Promise.resolve(true)
  return new Promise((resolve) => {
    let settled = false
    const finish = (exited: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.off('close', onExit)
      child.off('error', onExit)
      resolve(exited)
    }
    const onExit = (): void => finish(true)
    const timer = setTimeout(() => finish(hasExited(child)), Math.max(0, timeoutMs))
    child.once('close', onExit)
    child.once('error', onExit)
  })
}

export async function terminateChildProcess(
  child: ChildProcess,
  options: TerminationOptions = {}
): Promise<{ forced: boolean; exited: boolean }> {
  if (hasExited(child)) return { forced: false, exited: true }
  const gracefulExit = waitForExit(child, options.graceMs ?? 500)
  try { child.kill('SIGTERM') } catch { /* process may have exited between checks */ }
  if (await gracefulExit) return { forced: false, exited: true }

  const forcedExit = waitForExit(child, options.killWaitMs ?? 250)
  try { child.kill('SIGKILL') } catch { /* process may have exited between checks */ }
  return { forced: true, exited: await forcedExit }
}
