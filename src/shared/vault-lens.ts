export type LensDimension = 'project' | 'date' | 'tags' | 'harness' | 'turns' | 'source' | 'none'

// This is a stable vault path, not interface copy. Keep it locale-independent so
// changing the UI language never splits archived sessions across two folders.
export const SINGLE_TURN_ARCHIVE_FOLDER = '归档/单轮会话'

export type LensColor = 'blue' | 'green' | 'amber' | 'purple' | 'cyan' | 'pink' | 'orange'

export interface LensSession {
  id: string
  sessionId?: string
  updatedAt: string
  turnCount: number
  cwds?: string[]
  projectPath?: string
  source?: string
  isRemote?: boolean
}

export interface LensSessionMeta {
  tags?: string[]
  topic?: string
  topicConfidence?: number
}

export interface LensGroup<T extends LensSession = LensSession> {
  id: string
  label?: string
  labelKey?: string
  color: LensColor
  items: T[]
}

export interface LensOptions {
  now?: Date
  metaBySessionId?: Record<string, LensSessionMeta | undefined>
  cloudSessionIds?: ReadonlySet<string>
}

const COLORS: LensColor[] = ['blue', 'green', 'amber', 'purple', 'cyan', 'pink', 'orange']

function basename(value: string): string {
  const normalized = value.replace(/\\/g, '/').replace(/\/+$/, '')
  const part = normalized.slice(normalized.lastIndexOf('/') + 1)
  if (!part) return ''
  try { return decodeURIComponent(part) } catch { return part }
}

function projectIdentity(session: LensSession): string {
  const cwd = session.cwds?.find((value) => value.trim())
  if (cwd) return cwd.replace(/\\/g, '/').replace(/\/+$/, '')
  return session.projectPath?.trim() || ''
}

/** Human-facing project label. The original path remains only an internal grouping key. */
export function friendlyProjectName(session: LensSession): string {
  const cwd = session.cwds?.find((value) => value.trim())
  if (cwd) return basename(cwd)

  const projectPath = session.projectPath?.trim() || ''
  const directName = basename(projectPath)
  if (directName && !directName.startsWith('-')) return directName

  // Claude project directories encode paths with dashes. Showing the final segment is
  // friendlier than leaking the full "-Users-name-projects-foo" storage key.
  const encodedParts = directName.split('-').filter(Boolean)
  return encodedParts.at(-1) || ''
}

function startOfLocalDay(value: Date): Date {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate())
}

function dateBucket(iso: string, now: Date): string {
  const value = new Date(iso)
  if (Number.isNaN(value.getTime())) return 'older'

  const today = startOfLocalDay(now)
  const target = startOfLocalDay(value)
  const yesterday = new Date(today)
  yesterday.setDate(today.getDate() - 1)
  const weekStart = new Date(today)
  const mondayOffset = (today.getDay() + 6) % 7
  weekStart.setDate(today.getDate() - mondayOffset)
  const monthStart = new Date(today.getFullYear(), today.getMonth(), 1)

  if (target >= today) return 'today'
  if (target >= yesterday) return 'yesterday'
  if (target >= weekStart) return 'week'
  if (target >= monthStart) return 'month'
  return 'older'
}

function turnBucket(turnCount: number): string {
  if (turnCount <= 1) return 'single'
  if (turnCount < 10) return 'short'
  if (turnCount < 40) return 'medium'
  if (turnCount < 100) return 'long'
  return 'epic'
}

function sessionMeta<T extends LensSession>(
  session: T,
  metaBySessionId: Record<string, LensSessionMeta | undefined>
): LensSessionMeta | undefined {
  return metaBySessionId[session.sessionId || session.id] || metaBySessionId[session.id]
}

function orderedGroups<T extends LensSession>(
  buckets: Map<string, T[]>,
  definitions: Array<{ id: string; labelKey: string }>
): LensGroup<T>[] {
  return definitions.flatMap((definition, index) => {
    const items = buckets.get(definition.id)
    return items?.length
      ? [{ ...definition, color: COLORS[index % COLORS.length], items }]
      : []
  })
}

function groupProjects<T extends LensSession>(sessions: readonly T[]): LensGroup<T>[] {
  const buckets = new Map<string, T[]>()
  const baseLabels = new Map<string, string>()
  for (const session of sessions) {
    const identity = projectIdentity(session) || `unknown:${session.id}`
    const list = buckets.get(identity) || []
    list.push(session)
    buckets.set(identity, list)
    baseLabels.set(identity, friendlyProjectName(session))
  }

  const labelCounts = new Map<string, number>()
  for (const label of baseLabels.values()) labelCounts.set(label, (labelCounts.get(label) || 0) + 1)

  return Array.from(buckets.entries()).map(([identity, items], index) => {
    const baseLabel = baseLabels.get(identity) || ''
    const parentLabel = basename(identity.slice(0, identity.lastIndexOf('/')))
    const label = (labelCounts.get(baseLabel) || 0) > 1 && parentLabel
      ? `${baseLabel} · ${parentLabel}`
      : baseLabel
    return {
      id: `project:${identity}`,
      ...(label
        ? { label }
        : { labelKey: identity === '/' ? 'renderer.sidebar.group_root' : 'renderer.sidebar.group_no_project' }),
      color: COLORS[index % COLORS.length],
      items
    }
  })
}

export function groupSessionsByLens<T extends LensSession>(
  sessions: readonly T[],
  dimension: LensDimension,
  options: LensOptions = {}
): LensGroup<T>[] {
  const now = options.now || new Date()
  const metaBySessionId = options.metaBySessionId || {}

  if (dimension === 'none') {
    return sessions.length
      ? [{ id: 'all', labelKey: 'renderer.sidebar.group_all', color: 'purple', items: [...sessions] }]
      : []
  }
  if (dimension === 'project') return groupProjects(sessions)

  const buckets = new Map<string, T[]>()
  const add = (bucket: string, session: T): void => {
    const list = buckets.get(bucket) || []
    list.push(session)
    buckets.set(bucket, list)
  }

  for (const session of sessions) {
    if (dimension === 'date') {
      add(dateBucket(session.updatedAt, now), session)
    } else if (dimension === 'tags') {
      const tags = [...new Set((sessionMeta(session, metaBySessionId)?.tags || [])
        .map((tag) => tag.trim())
        .filter(Boolean))]
      if (tags.length === 0) add('untagged', session)
      else for (const tag of tags) add(`tag:${tag}`, session)
    } else if (dimension === 'harness') {
      add(`harness:${session.source || 'claude-code'}`, session)
    } else if (dimension === 'turns') {
      add(turnBucket(session.turnCount), session)
    } else if (dimension === 'source') {
      const sessionId = session.sessionId || session.id
      add(session.isRemote || options.cloudSessionIds?.has(sessionId) ? 'cloud' : 'local', session)
    }
  }

  if (dimension === 'date') {
    return orderedGroups(buckets, [
      { id: 'today', labelKey: 'renderer.sidebar.group_today' },
      { id: 'yesterday', labelKey: 'renderer.sidebar.group_yesterday' },
      { id: 'week', labelKey: 'renderer.sidebar.group_week' },
      { id: 'month', labelKey: 'renderer.sidebar.group_month' },
      { id: 'older', labelKey: 'renderer.sidebar.group_older' }
    ])
  }
  if (dimension === 'turns') {
    return orderedGroups(buckets, [
      { id: 'single', labelKey: 'renderer.sidebar.group_single' },
      { id: 'short', labelKey: 'renderer.sidebar.group_short' },
      { id: 'medium', labelKey: 'renderer.sidebar.group_medium' },
      { id: 'long', labelKey: 'renderer.sidebar.group_long' },
      { id: 'epic', labelKey: 'renderer.sidebar.group_epic' }
    ])
  }
  if (dimension === 'source') {
    return orderedGroups(buckets, [
      { id: 'local', labelKey: 'renderer.sidebar.group_local' },
      { id: 'cloud', labelKey: 'renderer.sidebar.group_cloud' }
    ])
  }

  return Array.from(buckets.entries()).map(([id, items], index) => ({
    id,
    ...(id === 'untagged'
      ? { labelKey: 'renderer.sidebar.group_untagged' }
      : { label: id.startsWith('tag:')
        ? id.slice(4)
        : id.startsWith('harness:')
          ? id.slice(8)
          : id }),
    color: COLORS[index % COLORS.length],
    items
  }))
}
