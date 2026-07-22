import { DefinitionRegistry, type RegistryDefinition } from './registry'

export interface CommandDefinition<TContext = unknown> extends RegistryDefinition {
  title: string
  category: string
  run: (context: TContext) => unknown | Promise<unknown>
}

export class CommandRegistry<TContext = unknown> extends DefinitionRegistry<CommandDefinition<TContext>> {}
