import { describe, expect, it } from 'vitest'
import {
  LibraryGlobalRecoveryCoordinator,
  normalizeLibraryGlobalRecoveryOperation,
  type LibraryGlobalRecoveryFault
} from './library-global-recovery-coordinator'

function fault(
  operation: LibraryGlobalRecoveryFault['operation'],
  healthRevision: number
): LibraryGlobalRecoveryFault {
  return { operation, healthRevision, errorCode: `E${healthRevision}` }
}

describe('LibraryGlobalRecoveryCoordinator', () => {
  it('promotes pre-initialization refresh and backlog failures to full initialization', () => {
    expect(normalizeLibraryGlobalRecoveryOperation({ kind: 'refresh' }, false))
      .toEqual({ kind: 'initial' })
    expect(normalizeLibraryGlobalRecoveryOperation({ kind: 'backlog', mode: 'provider' }, false))
      .toEqual({ kind: 'initial' })
    expect(normalizeLibraryGlobalRecoveryOperation({ kind: 'refresh' }, true))
      .toEqual({ kind: 'refresh' })
  })

  it('retains a refresh failure that arrives during backlog recovery', () => {
    const coordinator = new LibraryGlobalRecoveryCoordinator()
    coordinator.enqueue(fault({ kind: 'backlog', mode: 'automatic' }, 1))
    const backlog = coordinator.begin()
    expect(backlog?.operation).toEqual({ kind: 'backlog', mode: 'automatic' })

    coordinator.enqueue(fault({ kind: 'refresh' }, 2))
    expect(coordinator.succeed(backlog!)).toMatchObject({ healthRevision: 1 })
    expect(coordinator.hasWork).toBe(true)
    expect(coordinator.begin()).toMatchObject({
      operation: { kind: 'refresh' },
      healthRevision: 2
    })
  })

  it('does not let an unrelated normal success consume a scheduled refresh', () => {
    const coordinator = new LibraryGlobalRecoveryCoordinator()
    coordinator.enqueue(fault({ kind: 'refresh' }, 7))

    expect(coordinator.succeed({
      ...fault({ kind: 'backlog', mode: 'provider' }, 6),
      leaseId: 99
    })).toBeNull()
    expect(coordinator.pendingCount).toBe(1)
    expect(coordinator.begin()).toMatchObject({ healthRevision: 7 })
  })

  it('keeps a newer same-operation fault behind the active lease', () => {
    const coordinator = new LibraryGlobalRecoveryCoordinator()
    coordinator.enqueue(fault({ kind: 'refresh' }, 10))
    const first = coordinator.begin()!
    coordinator.enqueue(fault({ kind: 'refresh' }, 11))

    expect(coordinator.succeed(first)).toMatchObject({ healthRevision: 10 })
    expect(coordinator.begin()).toMatchObject({ healthRevision: 11 })
  })

  it('prefers a full initialization when several operations are pending', () => {
    const coordinator = new LibraryGlobalRecoveryCoordinator()
    coordinator.enqueue(fault({ kind: 'refresh' }, 20))
    coordinator.enqueue(fault({ kind: 'initial' }, 21))

    const initial = coordinator.begin()!
    expect(initial).toMatchObject({ operation: { kind: 'initial' } })
    coordinator.succeed(initial)
    expect(coordinator.hasWork).toBe(false)
  })

  it('does not activate promoted startup recovery before the session inventory is ready', () => {
    const coordinator = new LibraryGlobalRecoveryCoordinator()
    coordinator.enqueue(fault(
      normalizeLibraryGlobalRecoveryOperation({ kind: 'refresh' }, false),
      30
    ))
    let inventoryReady = false

    expect(coordinator.beginIf((operation) => operation.kind !== 'initial' || inventoryReady)).toBeNull()
    expect(coordinator.hasWork).toBe(true)
    expect(coordinator.isActive).toBe(false)

    inventoryReady = true
    const initialization = coordinator.beginIf(
      (operation) => operation.kind !== 'initial' || inventoryReady
    )!
    expect(initialization.operation).toEqual({ kind: 'initial' })
    coordinator.succeed(initialization)
    expect(coordinator.hasWork).toBe(false)
  })
})
