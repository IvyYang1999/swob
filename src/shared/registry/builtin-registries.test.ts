import { describe, expect, it, vi } from 'vitest'
import {
  BUILTIN_COMMAND_IDS,
  createBuiltinCommandRegistry
} from './builtin-commands'
import {
  BUILTIN_WIDGET_DECLARATIONS,
  createDefaultDashboardLayout,
  isDashboardLayoutConfig
} from './builtin-widgets'

describe('built-in registry declarations', () => {
  it('所有内置 GUI 命令均有唯一注册项并可通过统一上下文执行', async () => {
    const registry = createBuiltinCommandRegistry()
    expect(new Set(registry.list().map((command) => command.id))).toEqual(
      new Set(Object.values(BUILTIN_COMMAND_IDS))
    )
    expect(registry.list().every((command) => command.source.kind === 'builtin')).toBe(true)

    const openView = vi.fn()
    await registry.require(BUILTIN_COMMAND_IDS.viewInsights).run({ openView })
    expect(openView).toHaveBeenCalledWith('insights', undefined)
  })

  it('默认布局只引用已声明 widget，且每个内置 widget 恰好出现一次', () => {
    const layout = createDefaultDashboardLayout()
    const layoutIds = Object.values(layout.pages)
      .flatMap((page) => page.sections)
      .flatMap((section) => section.widgetIds)
    const declarationIds = BUILTIN_WIDGET_DECLARATIONS.map((widget) => widget.id)

    expect(new Set(layoutIds)).toEqual(new Set(declarationIds))
    expect(layoutIds).toHaveLength(declarationIds.length)
    expect(isDashboardLayoutConfig(layout)).toBe(true)
  })
})
