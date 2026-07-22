import { DefinitionRegistry, type RegistryDefinition } from './registry'

export type ViewPlacement = 'main' | 'overlay' | 'panel'

export interface ViewDefinition<TContext = unknown, TRender = unknown> extends RegistryDefinition {
  title: string
  placement: ViewPlacement
  render: (context: TContext) => TRender
}

export class ViewRegistry<TContext = unknown, TRender = unknown>
  extends DefinitionRegistry<ViewDefinition<TContext, TRender>> {}
