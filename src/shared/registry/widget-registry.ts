import { DefinitionRegistry, type RegistryDefinition } from './registry'

export type WidgetDataStatus = 'connected' | 'pending'

export type WidgetDataScope =
  | { kind: 'none' }
  | { kind: 'insights'; dimensions: string[] }
  | { kind: 'service'; service: string }

export interface WidgetSizeConstraints {
  minWidth: number
  defaultWidth: number
  maxWidth: number
}

export interface WidgetDefinition<TContext = unknown, TRender = unknown> extends RegistryDefinition {
  title: string
  page: string
  dataScope: WidgetDataScope
  size: WidgetSizeConstraints
  /** Whether the backend data pipeline for this widget is fully connected. */
  dataStatus: WidgetDataStatus
  render: (context: TContext) => TRender
}

export class WidgetRegistry<TContext = unknown, TRender = unknown>
  extends DefinitionRegistry<WidgetDefinition<TContext, TRender>> {
  listByPage(page: string): WidgetDefinition<TContext, TRender>[] {
    return this.list().filter((definition) => definition.page === page)
  }
}
