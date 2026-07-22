export type RegistrySource =
  | { kind: 'builtin' }
  | { kind: 'plugin'; pluginId: string }

export interface RegistryDefinition {
  id: string
  source: RegistrySource
}

type RegistryUpdate<T extends RegistryDefinition> = Partial<Omit<T, 'id' | 'source'>>

function validateDefinition(definition: RegistryDefinition): void {
  if (!/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(definition.id)) {
    throw new Error(`Invalid registry id: ${definition.id}`)
  }
  if (definition.source.kind === 'plugin' && !definition.source.pluginId) {
    throw new Error(`Plugin registry item ${definition.id} is missing pluginId`)
  }
}

function cloneAndFreeze<T>(value: T): T {
  if (Array.isArray(value)) {
    return Object.freeze(value.map((item) => cloneAndFreeze(item))) as T
  }
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const cloned = Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, cloneAndFreeze(item)])
    )
    return Object.freeze(cloned) as T
  }
  return value
}

function freezeDefinition<T extends RegistryDefinition>(definition: T): T {
  return cloneAndFreeze(definition)
}

export class DefinitionRegistry<T extends RegistryDefinition> {
  readonly #definitions = new Map<string, T>()

  get size(): number {
    return this.#definitions.size
  }

  register(definition: T): T {
    validateDefinition(definition)
    if (this.#definitions.has(definition.id)) {
      throw new Error(`Duplicate registry id: ${definition.id}`)
    }
    const stored = freezeDefinition(definition)
    this.#definitions.set(stored.id, stored)
    return stored
  }

  get(id: string): T | undefined {
    return this.#definitions.get(id)
  }

  require(id: string): T {
    const definition = this.get(id)
    if (!definition) throw new Error(`Unknown registry id: ${id}`)
    return definition
  }

  list(): T[] {
    return [...this.#definitions.values()]
  }

  update(id: string, patch: RegistryUpdate<T>): T {
    const current = this.require(id)
    const updated = freezeDefinition({ ...current, ...patch } as T)
    this.#definitions.set(id, updated)
    return updated
  }

  unregister(id: string): boolean {
    return this.#definitions.delete(id)
  }

  clear(): void {
    this.#definitions.clear()
  }
}
