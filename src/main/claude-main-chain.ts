export interface ClaudeChainRow {
  uuid?: string
  parentUuid?: string | null
  logicalParentUuid?: string | null
  isSidechain?: boolean
}

/**
 * Reproduce Claude's default-leaf selection without reading or mutating files.
 * The longest reachable non-sidechain UUID chain wins; a later leaf breaks ties.
 */
export function selectClaudeDefaultChain<T extends ClaudeChainRow>(rows: T[]): T[] {
  const indexed = rows
    .map((message, index) => ({ message, index }))
    .filter(({ message }) => !!message.uuid && !message.isSidechain)
  if (indexed.length === 0) return []

  const byUuid = new Map(indexed.map((entry) => [entry.message.uuid!, entry]))
  const parents = new Set<string>()
  for (const { message } of indexed) {
    if (message.parentUuid && byUuid.has(message.parentUuid)) parents.add(message.parentUuid)
    if (!message.parentUuid && message.logicalParentUuid && byUuid.has(message.logicalParentUuid)) {
      parents.add(message.logicalParentUuid)
    }
  }
  const leaves = indexed.filter(({ message }) => !parents.has(message.uuid!))
  if (leaves.length === 0) return indexed.map((entry) => entry.message)

  const trace = (leafUuid: string): Set<string> => {
    const chain = new Set<string>()
    let current: string | null | undefined = leafUuid
    while (current && !chain.has(current)) {
      const entry = byUuid.get(current)
      if (!entry) break
      chain.add(current)
      current = entry.message.parentUuid || entry.message.logicalParentUuid
    }
    return chain
  }

  const selected = leaves
    .map((entry) => ({ entry, chain: trace(entry.message.uuid!) }))
    .sort((left, right) =>
      right.chain.size - left.chain.size || right.entry.index - left.entry.index)[0]
  return rows.filter((message) => !message.isSidechain && !!message.uuid && selected.chain.has(message.uuid))
}
