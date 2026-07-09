import * as fs from 'fs'
import * as path from 'path'
import {
  findAllSessionFiles,
  parseSessionFile,
  resolvePhysicalSessionId
} from './session-loader'
import type { RawJsonlMessage } from './types'

export const SESSION_LINEAGE_FILE = '.session-lineage.json'

type LineageEvidenceType = 'uuid-parent-chain'

export interface LineageEvidence {
  type: LineageEvidenceType
  overlapCount: number
  parentCoverage: number
  childCoverage: number
  parentUuid: string
  childFirstNewUuid: string
  childFirstNewAt: string
  parentUpdatedAt: string
  childUpdatedAt: string
  cwdMatched: boolean
}

export interface LineageRelation {
  from: string
  to: string
  evidence: LineageEvidence
}

export interface LineageSessionEntry {
  sessionId: string
  rootSessionId: string
  latestResumeId: string
  isAlias: boolean
  source: 'claude-code'
  createdAt: string
  updatedAt: string
}

export interface LineageAmbiguity {
  sessionId: string
  reason: string
  candidates: Array<{
    sessionId: string
    updatedAt: string
    overlapCount: number
    parentCoverage: number
  }>
}

export interface SessionLineageRegistry {
  version: 1
  generatedAt: string
  libraryRoot: string
  /** old session id -> latest resume id; aliases are not necessarily stepwise. */
  aliases: Record<string, string>
  latestByRoot: Record<string, string>
  sessions: Record<string, LineageSessionEntry>
  relations: LineageRelation[]
  ambiguous: LineageAmbiguity[]
}

interface LineageRow extends RawJsonlMessage {
  __filePath: string
  __lineIndex: number
  __fileIndex: number
}

interface LineageRecord {
  sessionId: string
  rows: LineageRow[]
  uuidRows: LineageRow[]
  uuidSet: Set<string>
  createdAt: string
  updatedAt: string
  cwds: Set<string>
}

interface CandidateRelation extends LineageRelation {
  fromRecord: LineageRecord
  toRecord: LineageRecord
}

interface BlockedLineageCandidate {
  reason: 'missing-cwd-cannot-confirm-lineage'
  candidate: CandidateRelation
}

interface BuildOptions {
  libraryRoot?: string
  generatedAt?: string
}

const MIN_PARENT_COVERAGE = 0.7

export function getSessionLineagePath(libraryRoot: string): string {
  return path.join(libraryRoot, SESSION_LINEAGE_FILE)
}

export async function rebuildSessionLineageRegistry(
  libraryRoot: string,
  options: Omit<BuildOptions, 'libraryRoot'> = {}
): Promise<SessionLineageRegistry> {
  return buildSessionLineageRegistryFromClaudeFiles(findAllSessionFiles(), {
    ...options,
    libraryRoot
  })
}

export function writeSessionLineageRegistry(registry: SessionLineageRegistry, filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, JSON.stringify(registry, null, 2) + '\n', 'utf-8')
}

export async function buildSessionLineageRegistryFromClaudeFiles(
  filePaths: string[],
  options: BuildOptions = {}
): Promise<SessionLineageRegistry> {
  const records = await loadLineageRecords(filePaths)
  const { relations, ambiguous } = selectRelations(records)
  return buildRegistry(records, relations, ambiguous, options)
}

async function loadLineageRecords(filePaths: string[]): Promise<LineageRecord[]> {
  const grouped = new Map<string, LineageRow[]>()

  for (let fileIndex = 0; fileIndex < filePaths.length; fileIndex++) {
    const filePath = filePaths[fileIndex]
    let raw: RawJsonlMessage[]
    try {
      raw = await parseSessionFile(filePath)
    } catch {
      continue
    }

    const sessionId = resolvePhysicalSessionId(filePath, raw)
    if (!sessionId) continue

    const rows = raw.map((row, lineIndex) => ({
      ...row,
      __filePath: filePath,
      __lineIndex: lineIndex,
      __fileIndex: fileIndex
    }))

    const current = grouped.get(sessionId) || []
    current.push(...rows)
    grouped.set(sessionId, current)
  }

  const records: LineageRecord[] = []
  for (const [sessionId, rows] of grouped) {
    const sortedRows = sortRows(rows)
    const uuidRows = dedupeUuidRows(sortedRows)
    const timestamps = sortedRows.map((row) => row.timestamp).filter(Boolean).sort()
    if (uuidRows.length === 0 || timestamps.length === 0) continue

    records.push({
      sessionId,
      rows: sortedRows,
      uuidRows,
      uuidSet: new Set(uuidRows.map((row) => row.uuid)),
      createdAt: timestamps[0],
      updatedAt: timestamps[timestamps.length - 1],
      cwds: new Set(sortedRows.map((row) => row.cwd).filter((cwd): cwd is string => !!cwd))
    })
  }

  return records
}

function sortRows(rows: LineageRow[]): LineageRow[] {
  return [...rows].sort((a, b) => {
    const ts = compareTimestamp(a.timestamp, b.timestamp)
    if (ts !== 0) return ts
    if (a.__fileIndex !== b.__fileIndex) return a.__fileIndex - b.__fileIndex
    return a.__lineIndex - b.__lineIndex
  })
}

function dedupeUuidRows(rows: LineageRow[]): LineageRow[] {
  const seen = new Set<string>()
  const out: LineageRow[] = []
  for (const row of rows) {
    if (!row.uuid || seen.has(row.uuid)) continue
    seen.add(row.uuid)
    out.push(row)
  }
  return out
}

function compareTimestamp(a?: string, b?: string): number {
  if (!a && !b) return 0
  if (!a) return 1
  if (!b) return -1
  return a.localeCompare(b)
}

function selectRelations(records: LineageRecord[]): {
  relations: LineageRelation[]
  ambiguous: LineageAmbiguity[]
} {
  const candidatesByParent = new Map<string, CandidateRelation[]>()
  const blockedByParent = new Map<string, BlockedLineageCandidate[]>()
  const allConfirmedCandidates: CandidateRelation[] = []

  for (const parent of records) {
    for (const child of records) {
      if (parent.sessionId === child.sessionId) continue
      const candidate = buildStructuralCandidateRelation(parent, child)
      if (!candidate) continue

      const cwdCompatibility = getCwdCompatibility(parent, child)
      if (cwdCompatibility === 'missing') {
        const list = blockedByParent.get(parent.sessionId) || []
        list.push({
          reason: 'missing-cwd-cannot-confirm-lineage',
          candidate
        })
        blockedByParent.set(parent.sessionId, list)
        continue
      }
      if (cwdCompatibility === 'mismatch') continue

      const list = candidatesByParent.get(parent.sessionId) || []
      list.push(candidate)
      candidatesByParent.set(parent.sessionId, list)
      allConfirmedCandidates.push(candidate)
    }
  }

  const selectedCandidates: CandidateRelation[] = []
  const ambiguous: LineageAmbiguity[] = []

  for (const [sessionId, candidates] of candidatesByParent) {
    candidates.sort(compareCandidates)
    const top = candidates[0]
    const second = candidates[1]

    if (second && isAmbiguousTopCandidate(top, second)) {
      ambiguous.push({
        sessionId,
        reason: 'multiple-equally-plausible-lineage-targets',
        candidates: candidates.slice(0, 3).map((candidate) => ({
          sessionId: candidate.to,
          updatedAt: candidate.toRecord.updatedAt,
          overlapCount: candidate.evidence.overlapCount,
          parentCoverage: candidate.evidence.parentCoverage
        }))
      })
      continue
    }

    selectedCandidates.push(top)
  }

  for (const [sessionId, blocked] of blockedByParent) {
    if (candidatesByParent.has(sessionId)) continue
    blocked.sort((a, b) => compareCandidates(a.candidate, b.candidate))
    ambiguous.push({
      sessionId,
      reason: 'missing-cwd-cannot-confirm-lineage',
      candidates: blocked.slice(0, 3).map(({ candidate }) => ({
        sessionId: candidate.to,
        updatedAt: candidate.toRecord.updatedAt,
        overlapCount: candidate.evidence.overlapCount,
        parentCoverage: candidate.evidence.parentCoverage
      }))
    })
  }

  const relations = removeChildAmbiguities(selectedCandidates, allConfirmedCandidates, ambiguous)
  return { relations, ambiguous }
}

function compareCandidates(a: CandidateRelation, b: CandidateRelation): number {
  const updated = b.toRecord.updatedAt.localeCompare(a.toRecord.updatedAt)
  if (updated !== 0) return updated
  if (b.evidence.parentCoverage !== a.evidence.parentCoverage) {
    return b.evidence.parentCoverage - a.evidence.parentCoverage
  }
  return b.evidence.overlapCount - a.evidence.overlapCount
}

function isAmbiguousTopCandidate(a: CandidateRelation, b: CandidateRelation): boolean {
  return a.toRecord.updatedAt === b.toRecord.updatedAt &&
    Math.abs(a.evidence.parentCoverage - b.evidence.parentCoverage) < 0.05 &&
    Math.abs(a.evidence.overlapCount - b.evidence.overlapCount) <= 2
}

function buildStructuralCandidateRelation(parent: LineageRecord, child: LineageRecord): CandidateRelation | null {
  if (!isLater(child.updatedAt, parent.updatedAt)) return null
  if (hasForkedFrom(child)) return null

  const overlapCount = countOverlap(parent.uuidSet, child.uuidSet)
  const requiredOverlap = requiredOverlapCount(parent.uuidSet.size)
  if (overlapCount < requiredOverlap) return null

  const parentCoverage = overlapCount / parent.uuidSet.size
  if (parentCoverage < MIN_PARENT_COVERAGE) return null

  const childCoverage = overlapCount / child.uuidSet.size
  const firstNew = child.uuidRows.find((row) => !parent.uuidSet.has(row.uuid))
  if (!firstNew?.parentUuid || !parent.uuidSet.has(firstNew.parentUuid)) return null

  const firstNewIdx = child.uuidRows.findIndex((row) => row.uuid === firstNew.uuid)
  const lastSharedBefore = findLastSharedBefore(child.uuidRows, parent.uuidSet, firstNewIdx)
  if (!lastSharedBefore || lastSharedBefore.uuid !== firstNew.parentUuid) return null

  return {
    from: parent.sessionId,
    to: child.sessionId,
    fromRecord: parent,
    toRecord: child,
    evidence: {
      type: 'uuid-parent-chain',
      overlapCount,
      parentCoverage: roundRatio(parentCoverage),
      childCoverage: roundRatio(childCoverage),
      parentUuid: firstNew.parentUuid,
      childFirstNewUuid: firstNew.uuid,
      childFirstNewAt: firstNew.timestamp || '',
      parentUpdatedAt: parent.updatedAt,
      childUpdatedAt: child.updatedAt,
      cwdMatched: true
    }
  }
}

function isLater(a: string, b: string): boolean {
  return !!a && !!b && a > b
}

function hasForkedFrom(record: LineageRecord): boolean {
  return record.rows.some((row) => !!row.forkedFrom)
}

function getCwdCompatibility(parent: LineageRecord, child: LineageRecord): 'matched' | 'missing' | 'mismatch' {
  if (parent.cwds.size === 0 || child.cwds.size === 0) return 'missing'
  for (const cwd of parent.cwds) {
    if (child.cwds.has(cwd)) return 'matched'
  }
  return 'mismatch'
}

function countOverlap(a: Set<string>, b: Set<string>): number {
  let count = 0
  for (const value of a) {
    if (b.has(value)) count++
  }
  return count
}

function requiredOverlapCount(parentUuidCount: number): number {
  return Math.min(8, Math.max(2, Math.ceil(parentUuidCount * 0.5)))
}

function findLastSharedBefore(
  rows: LineageRow[],
  parentUuids: Set<string>,
  beforeIndex: number
): LineageRow | null {
  for (let i = beforeIndex - 1; i >= 0; i--) {
    if (parentUuids.has(rows[i].uuid)) return rows[i]
  }
  return null
}

function roundRatio(value: number): number {
  return Number(value.toFixed(3))
}

function removeChildAmbiguities(
  selectedCandidates: CandidateRelation[],
  allConfirmedCandidates: CandidateRelation[],
  ambiguous: LineageAmbiguity[]
): LineageRelation[] {
  const candidatesByChild = new Map<string, CandidateRelation[]>()
  for (const candidate of selectedCandidates) {
    const list = candidatesByChild.get(candidate.to) || []
    list.push(candidate)
    candidatesByChild.set(candidate.to, list)
  }

  const ambiguousChildren = new Set<string>()
  for (const [childId, candidates] of candidatesByChild) {
    const parentIds = [...new Set(candidates.map((candidate) => candidate.from))]
    if (parentIds.length < 2) continue
    if (areLineageParentsRelated(parentIds, childId, allConfirmedCandidates)) continue

    ambiguousChildren.add(childId)
    ambiguous.push({
      sessionId: childId,
      reason: 'multiple-unrelated-lineage-parents',
      candidates: candidates
        .sort((a, b) => a.from.localeCompare(b.from))
        .map((candidate) => ({
          sessionId: candidate.from,
          updatedAt: candidate.fromRecord.updatedAt,
          overlapCount: candidate.evidence.overlapCount,
          parentCoverage: candidate.evidence.parentCoverage
        }))
    })
  }

  return selectedCandidates
    .filter((candidate) => !ambiguousChildren.has(candidate.to))
    .map((candidate) => ({
      from: candidate.from,
      to: candidate.to,
      evidence: candidate.evidence
    }))
}

function areLineageParentsRelated(
  parentIds: string[],
  childId: string,
  candidates: CandidateRelation[]
): boolean {
  for (let i = 0; i < parentIds.length; i++) {
    for (let j = i + 1; j < parentIds.length; j++) {
      const a = parentIds[i]
      const b = parentIds[j]
      if (!hasCandidatePath(a, b, childId, candidates) && !hasCandidatePath(b, a, childId, candidates)) {
        return false
      }
    }
  }
  return true
}

function hasCandidatePath(
  from: string,
  to: string,
  excludedChildId: string,
  candidates: CandidateRelation[]
): boolean {
  const queue = [from]
  const seen = new Set<string>(queue)

  while (queue.length > 0) {
    const current = queue.shift()!
    for (const candidate of candidates) {
      if (candidate.from !== current) continue
      if (candidate.from === excludedChildId || candidate.to === excludedChildId) continue
      if (candidate.to === to) return true
      if (seen.has(candidate.to)) continue
      seen.add(candidate.to)
      queue.push(candidate.to)
    }
  }

  return false
}

function buildRegistry(
  records: LineageRecord[],
  relations: LineageRelation[],
  ambiguous: LineageAmbiguity[],
  options: BuildOptions
): SessionLineageRegistry {
  const components = buildComponents(records, relations)
  const aliases: Record<string, string> = {}
  const latestByRoot: Record<string, string> = {}
  const sessions: Record<string, LineageSessionEntry> = {}
  const incoming = new Set(relations.map((relation) => relation.to))

  for (const component of components) {
    const sortedByCreated = [...component].sort((a, b) => {
      const created = a.createdAt.localeCompare(b.createdAt)
      if (created !== 0) return created
      return a.sessionId.localeCompare(b.sessionId)
    })
    const sortedByUpdated = [...component].sort((a, b) => {
      const updated = b.updatedAt.localeCompare(a.updatedAt)
      if (updated !== 0) return updated
      return b.sessionId.localeCompare(a.sessionId)
    })

    const rootCandidates = sortedByCreated.filter((record) => !incoming.has(record.sessionId))
    const root = rootCandidates[0] || sortedByCreated[0]
    const latest = sortedByUpdated[0]
    latestByRoot[root.sessionId] = latest.sessionId

    for (const record of component) {
      if (record.sessionId !== latest.sessionId) {
        aliases[record.sessionId] = latest.sessionId
      }
      sessions[record.sessionId] = {
        sessionId: record.sessionId,
        rootSessionId: root.sessionId,
        latestResumeId: latest.sessionId,
        isAlias: record.sessionId !== latest.sessionId,
        source: 'claude-code',
        createdAt: record.createdAt,
        updatedAt: record.updatedAt
      }
    }
  }

  return {
    version: 1,
    generatedAt: options.generatedAt || new Date().toISOString(),
    libraryRoot: options.libraryRoot || '',
    aliases: sortObject(aliases),
    latestByRoot: sortObject(latestByRoot),
    sessions: sortObject(sessions),
    relations: [...relations].sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to)),
    ambiguous: [...ambiguous].sort((a, b) => a.sessionId.localeCompare(b.sessionId))
  }
}

function buildComponents(records: LineageRecord[], relations: LineageRelation[]): LineageRecord[][] {
  const byId = new Map(records.map((record) => [record.sessionId, record]))
  const parent = new Map(records.map((record) => [record.sessionId, record.sessionId]))

  function find(id: string): string {
    const current = parent.get(id)
    if (!current || current === id) return id
    const root = find(current)
    parent.set(id, root)
    return root
  }

  function union(a: string, b: string): void {
    const rootA = find(a)
    const rootB = find(b)
    if (rootA !== rootB) parent.set(rootB, rootA)
  }

  for (const relation of relations) {
    if (!byId.has(relation.from) || !byId.has(relation.to)) continue
    union(relation.from, relation.to)
  }

  const grouped = new Map<string, LineageRecord[]>()
  for (const record of records) {
    const root = find(record.sessionId)
    const group = grouped.get(root) || []
    group.push(record)
    grouped.set(root, group)
  }

  return [...grouped.values()]
}

function sortObject<T>(obj: Record<string, T>): Record<string, T> {
  return Object.fromEntries(
    Object.entries(obj).sort(([a], [b]) => a.localeCompare(b))
  ) as Record<string, T>
}
