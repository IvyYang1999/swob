import { parentPort, workerData } from 'node:worker_threads'
import { buildDuplicateRecoveryReport } from './duplicate-recovery-planner'
import type { DuplicateRecoveryProgress } from '../shared/duplicate-recovery-contract'
import { duplicateRecoveryErrorCode } from './duplicate-recovery-failure-code'

interface WorkerInput {
  libraryRoot: string
  quarantineRoot: string
  testDelayMs?: number
}

const input = workerData as WorkerInput
let lastProgressPhase: DuplicateRecoveryProgress['phase'] | null = null

async function run(): Promise<Awaited<ReturnType<typeof buildDuplicateRecoveryReport>>> {
  if (input.testDelayMs && input.testDelayMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, input.testDelayMs))
  }
  return buildDuplicateRecoveryReport(input.libraryRoot, {
    quarantineRoot: input.quarantineRoot,
    hashSources: true,
    inventoryScope: 'repair-candidates',
    onProgress: (progress: DuplicateRecoveryProgress) => {
      const phaseChanged = progress.phase !== lastProgressPhase
      lastProgressPhase = progress.phase
      if (!phaseChanged && progress.phase === 'discovering' && progress.discoveredPackages % 25 !== 0) return
      parentPort?.postMessage({ kind: 'progress', progress })
    }
  })
}

void run().then((report) => {
  parentPort?.postMessage({ kind: 'complete', report })
}).catch((error) => {
  parentPort?.postMessage({
    kind: 'error',
    errorCode: duplicateRecoveryErrorCode(error)
  })
})
