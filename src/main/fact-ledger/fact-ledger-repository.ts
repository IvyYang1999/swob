import Database from 'better-sqlite3'
import type { CanonicalEvent } from '../../shared/provider-schema-v2.generated'
import type { InteractionTrajectoryReadModel } from '../../shared/contracts/truth-kernel'
import { projectInteractionLedger, projectTrajectory, type InteractionLedgerProjection } from './interaction-projector'

export interface ProjectionCheckpoint {
  schemaVersion: 1
  projectorVersion: 't211D/2'
  eventCount: number
  lastSequence: number | null
  lastEventId: string | null
}

export interface FactLedgerSnapshot extends InteractionLedgerProjection {
  checkpoint: ProjectionCheckpoint
  trajectories: InteractionTrajectoryReadModel[]
}

export interface FactLedgerRepository {
  append(events: readonly CanonicalEvent[]): FactLedgerSnapshot
  rebuild(events: readonly CanonicalEvent[]): FactLedgerSnapshot
  read(): FactLedgerSnapshot
  close(): void
}

const EMPTY_PROJECTION: InteractionLedgerProjection = {
  interactions: [], fileActions: [], usageAttributions: [], branchUsageRollups: [], forkBoundaries: []
}

function checkpoint(events: readonly CanonicalEvent[]): ProjectionCheckpoint {
  const last = [...events].sort((a, b) => b.sequence - a.sequence || b.id.localeCompare(a.id))[0]
  return {
    schemaVersion: 1,
    projectorVersion: 't211D/2',
    eventCount: events.length,
    lastSequence: last?.sequence ?? null,
    lastEventId: last?.id ?? null
  }
}

/**
 * SQLite is the durable source for raw projection inputs and the atomic read snapshot.
 * A transaction either advances events + checkpoint + snapshot together or advances none.
 */
export function openFactLedgerRepository(databasePath: string): FactLedgerRepository {
  const database = new Database(databasePath)
  database.pragma('journal_mode = WAL')
  database.pragma('synchronous = FULL')
  database.exec(`
    CREATE TABLE IF NOT EXISTS fact_ledger_events (
      event_id TEXT PRIMARY KEY,
      sequence INTEGER NOT NULL,
      event_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS fact_ledger_projection (
      singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
      projector_version TEXT NOT NULL,
      checkpoint_json TEXT NOT NULL,
      snapshot_json TEXT NOT NULL
    );
  `)
  const upsertEvent = database.prepare(`
    INSERT INTO fact_ledger_events(event_id, sequence, event_json) VALUES (?, ?, ?)
    ON CONFLICT(event_id) DO UPDATE SET sequence = excluded.sequence, event_json = excluded.event_json
  `)
  const readEvents = (): CanonicalEvent[] => (database.prepare(
    'SELECT event_json FROM fact_ledger_events ORDER BY sequence, event_id'
  ).all() as Array<{ event_json: string }>).map((row) => JSON.parse(row.event_json) as CanonicalEvent)
  const materialize = (events: readonly CanonicalEvent[]): FactLedgerSnapshot => {
    const projection = projectInteractionLedger(events)
    const usageByInteraction = new Map<string, typeof projection.usageAttributions>()
    const filesByInteraction = new Map<string, typeof projection.fileActions>()
    const rollupsBySession = new Map<string, typeof projection.branchUsageRollups>()
    for (const row of projection.usageAttributions) usageByInteraction.set(row.interactionId, [...(usageByInteraction.get(row.interactionId) ?? []), row])
    for (const row of projection.fileActions) filesByInteraction.set(row.interactionId, [...(filesByInteraction.get(row.interactionId) ?? []), row])
    for (const row of projection.branchUsageRollups) rollupsBySession.set(row.logicalSessionId, [...(rollupsBySession.get(row.logicalSessionId) ?? []), row])
    const trajectories = projection.interactions.map((interaction) => projectTrajectory(
      interaction,
      usageByInteraction.get(interaction.interactionId) ?? [],
      filesByInteraction.get(interaction.interactionId) ?? [],
      projection.forkBoundaries.find((boundary) => boundary.childLogicalSessionId === interaction.logicalSessionId),
      rollupsBySession.get(interaction.logicalSessionId) ?? []
    ))
    return { ...projection, trajectories, checkpoint: checkpoint(events) }
  }
  const storeSnapshot = database.prepare(`
    INSERT INTO fact_ledger_projection(singleton, projector_version, checkpoint_json, snapshot_json)
    VALUES (1, ?, ?, ?)
    ON CONFLICT(singleton) DO UPDATE SET
      projector_version = excluded.projector_version,
      checkpoint_json = excluded.checkpoint_json,
      snapshot_json = excluded.snapshot_json
  `)
  const persist = database.transaction((events: readonly CanonicalEvent[], replace: boolean) => {
    if (replace) database.prepare('DELETE FROM fact_ledger_events').run()
    for (const event of events) upsertEvent.run(event.id, event.sequence, JSON.stringify(event))
    const snapshot = materialize(readEvents())
    storeSnapshot.run('t211D/2', JSON.stringify(snapshot.checkpoint), JSON.stringify(snapshot))
    return snapshot
  })
  return {
    append: (events) => persist(events, false),
    rebuild: (events) => persist(events, true),
    read() {
      const row = database.prepare('SELECT snapshot_json FROM fact_ledger_projection WHERE singleton = 1').get() as { snapshot_json: string } | undefined
      return row ? JSON.parse(row.snapshot_json) as FactLedgerSnapshot : {
        ...EMPTY_PROJECTION,
        trajectories: [],
        checkpoint: checkpoint([])
      }
    },
    close: () => database.close()
  }
}
