// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import {
  BUILTIN_WIDGET_DECLARATIONS,
  createDefaultDashboardLayout
} from '../../../shared/registry/builtin-widgets'
import { BUILTIN_VIEW_IDS, builtinViewRegistry } from './builtin-view-registry'
import { builtinWidgetRegistry, resolveDashboardPageSections } from './builtin-widget-registry'

describe('renderer built-in registries', () => {
  it('注册全部 Insights widget renderer', () => {
    expect(builtinWidgetRegistry.list().map((widget) => widget.id)).toEqual(
      BUILTIN_WIDGET_DECLARATIONS.map((widget) => widget.id)
    )
    expect(builtinWidgetRegistry.list().every((widget) => typeof widget.render === 'function')).toBe(true)
  })

  it('按 dashboard.json 的顺序与可见性解析注册卡片', () => {
    const layout = createDefaultDashboardLayout()
    const breakdowns = layout.pages.overview.sections.find((section) => section.id === 'breakdowns')!
    breakdowns.widgetIds = ['overview.top-projects', 'overview.by-source']

    expect(resolveDashboardPageSections(layout, 'overview')
      .find((section) => section.id === 'breakdowns')!
      .widgets.map((widget) => widget.id)).toEqual([
      'overview.top-projects',
      'overview.by-source'
    ])
  })

  it('声明 chat / insights / lineage / settings 主视图入口', () => {
    expect(builtinViewRegistry.require(BUILTIN_VIEW_IDS.chat).placement).toBe('main')
    expect(builtinViewRegistry.require(BUILTIN_VIEW_IDS.insights).placement).toBe('main')
    expect(builtinViewRegistry.require(BUILTIN_VIEW_IDS.lineage).placement).toBe('main')
    expect(builtinViewRegistry.require(BUILTIN_VIEW_IDS.settings).placement).toBe('overlay')
  })
})
