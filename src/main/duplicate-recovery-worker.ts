import { parentPort, workerData } from 'node:worker_threads'
import { buildDuplicateRecoveryReport } from './duplicate-recovery-planner'
import type { DuplicateRecoveryProgress } from '../shared/duplicate-recovery-contract'

interface WorkerInput {
  libraryRoot: string
  quarantineRoot: string
}

const input = workerData as WorkerInput
let lastProgressPhase: DuplicateRecoveryProgress['phase'] | null = null

void buildDuplicateRecoveryReport(input.libraryRoot, {
  quarantineRoot: input.quarantineRoot,
  hashSources: true,
  inventoryScope: 'repair-candidates',
  onProgress: (progress: DuplicateRecoveryProgress) => {
    const phaseChanged = progress.phase !== lastProgressPhase
    lastProgressPhase = progress.phase
    if (!phaseChanged && progress.phase === 'discovering' && progress.discoveredPackages % 25 !== 0) return
    parentPort?.postMessage({ kind: 'progress', progress })
  }
}).then((report) => {
  parentPort?.postMessage({ kind: 'complete', report })
}).catch((error) => {
  parentPort?.postMessage({
    kind: 'error',
    error: error instanceof Error ? error.message : String(error)
  })
})
