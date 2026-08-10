import type { OrchestrationRegistrationDescriptor } from '../../shared/contracts/truth-kernel'
import { MULTICA_ORCHESTRATION_DESCRIPTOR } from './multica'

/** t211I is the sole Merge 1 orchestration registration owner. */
export const ORCHESTRATION_REGISTRATIONS: readonly OrchestrationRegistrationDescriptor[] = [
  MULTICA_ORCHESTRATION_DESCRIPTOR
]

export function orchestrationRegistration(orchestratorId: string): OrchestrationRegistrationDescriptor | undefined {
  return ORCHESTRATION_REGISTRATIONS.find((descriptor) => descriptor.orchestratorId === orchestratorId)
}
