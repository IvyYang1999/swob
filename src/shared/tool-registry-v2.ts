import type { CanonicalEventKind, JsonValue } from './provider-schema-v2.generated'

export interface RawToolCallV2 {
  providerId: string
  formatVersion: string | null
  rawName: string
  callId: string
  input: JsonValue
}

export interface ToolPresentationV2 {
  component: 'tool-card' | 'terminal-card' | 'diff-card' | 'interaction-card' | 'permission-card' | 'generic-tool-card'
  label: string
  resultComponent: 'tool-result' | 'terminal-result' | 'diff-result' | 'interaction-result' | 'permission-result' | 'generic-result'
}

export interface ResolvedToolV2 {
  rawName: string
  callId: string
  semanticToolId: string
  eventKind: CanonicalEventKind
  normalizedInput: JsonValue
  presentation: ToolPresentationV2
}

export interface RawToolAliasV2 {
  providerId: string
  formatVersion?: string
  rawName: string
  semanticToolId: string
  normalize?: (input: JsonValue) => JsonValue
}

export interface SemanticToolV2 {
  id: string
  eventKind: CanonicalEventKind
}

const FALLBACK_SEMANTIC: SemanticToolV2 = { id: 'tool.unknown', eventKind: 'tool.call' }
const FALLBACK_PRESENTATION: ToolPresentationV2 = {
  component: 'generic-tool-card',
  label: 'Unknown tool',
  resultComponent: 'generic-result'
}

function aliasKey(providerId: string, formatVersion: string, rawName: string): string {
  return `${providerId}\0${formatVersion}\0${rawName}`
}

export class ToolRegistryV2 {
  private readonly aliases = new Map<string, RawToolAliasV2>()
  private readonly semantics = new Map<string, SemanticToolV2>()
  private readonly presentations = new Map<string, ToolPresentationV2>()

  registerSemantic(semantic: SemanticToolV2): this {
    if (this.semantics.has(semantic.id)) throw new Error(`semantic-tool-duplicate:${semantic.id}`)
    this.semantics.set(semantic.id, structuredClone(semantic))
    return this
  }

  registerAlias(alias: RawToolAliasV2): this {
    if (!this.semantics.has(alias.semanticToolId)) {
      throw new Error(`semantic-tool-unregistered:${alias.semanticToolId}`)
    }
    const key = aliasKey(alias.providerId, alias.formatVersion || '*', alias.rawName)
    if (this.aliases.has(key)) throw new Error(`raw-tool-alias-duplicate:${key}`)
    this.aliases.set(key, alias)
    return this
  }

  registerPresentation(semanticToolId: string, presentation: ToolPresentationV2): this {
    if (!this.semantics.has(semanticToolId)) throw new Error(`semantic-tool-unregistered:${semanticToolId}`)
    if (this.presentations.has(semanticToolId)) throw new Error(`tool-presentation-duplicate:${semanticToolId}`)
    this.presentations.set(semanticToolId, structuredClone(presentation))
    return this
  }

  resolve(call: RawToolCallV2): ResolvedToolV2 {
    const formatVersion = call.formatVersion || '*'
    const alias = this.aliases.get(aliasKey(call.providerId, formatVersion, call.rawName)) ||
      this.aliases.get(aliasKey(call.providerId, '*', call.rawName))
    const semantic = alias ? this.semantics.get(alias.semanticToolId)! : FALLBACK_SEMANTIC
    return {
      rawName: call.rawName,
      callId: call.callId,
      semanticToolId: semantic.id,
      eventKind: semantic.eventKind,
      normalizedInput: alias?.normalize ? alias.normalize(call.input) : structuredClone(call.input),
      presentation: structuredClone(this.presentations.get(semantic.id) || FALLBACK_PRESENTATION)
    }
  }
}

function semantic(id: string, eventKind: CanonicalEventKind): SemanticToolV2 {
  return { id, eventKind }
}

function presentation(
  component: ToolPresentationV2['component'],
  label: string,
  resultComponent: ToolPresentationV2['resultComponent']
): ToolPresentationV2 {
  return { component, label, resultComponent }
}

export function createBuiltinToolRegistryV2(): ToolRegistryV2 {
  const registry = new ToolRegistryV2()
  for (const entry of [
    semantic('filesystem.read', 'tool.call'),
    semantic('filesystem.write', 'tool.call'),
    semantic('shell.execute', 'tool.call'),
    semantic('diff.apply', 'tool.call'),
    semantic('interaction.question', 'interaction.request'),
    semantic('permission.request', 'permission.request'),
    FALLBACK_SEMANTIC
  ]) registry.registerSemantic(entry)

  registry
    .registerPresentation('filesystem.read', presentation('tool-card', 'Read file', 'tool-result'))
    .registerPresentation('filesystem.write', presentation('tool-card', 'Write file', 'tool-result'))
    .registerPresentation('shell.execute', presentation('terminal-card', 'Run command', 'terminal-result'))
    .registerPresentation('diff.apply', presentation('diff-card', 'Apply patch', 'diff-result'))
    .registerPresentation('interaction.question', presentation('interaction-card', 'Question', 'interaction-result'))
    .registerPresentation('permission.request', presentation('permission-card', 'Permission', 'permission-result'))
    .registerPresentation('tool.unknown', FALLBACK_PRESENTATION)

  const aliases: RawToolAliasV2[] = [
    { providerId: 'swob/claude-code', rawName: 'Read', semanticToolId: 'filesystem.read' },
    { providerId: 'swob/claude-code', rawName: 'Write', semanticToolId: 'filesystem.write' },
    { providerId: 'swob/claude-code', rawName: 'Bash', semanticToolId: 'shell.execute' },
    { providerId: 'swob/claude-code', rawName: 'AskUserQuestion', semanticToolId: 'interaction.question' },
    { providerId: 'swob/claude-code', rawName: 'RequestPermissions', semanticToolId: 'permission.request' },
    { providerId: 'swob/codex', rawName: 'exec_command', semanticToolId: 'shell.execute' },
    { providerId: 'swob/codex', rawName: 'apply_patch', semanticToolId: 'diff.apply' },
    { providerId: 'swob/pi', rawName: 'read', semanticToolId: 'filesystem.read' },
    { providerId: 'swob/pi', rawName: 'write', semanticToolId: 'filesystem.write' },
    { providerId: 'swob/pi', rawName: 'bash', semanticToolId: 'shell.execute' }
  ]
  for (const alias of aliases) registry.registerAlias(alias)
  return registry
}
