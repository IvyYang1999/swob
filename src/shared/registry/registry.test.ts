import { describe, expect, it, vi } from 'vitest'
import { CommandRegistry } from './command-registry'
import { ViewRegistry } from './view-registry'
import { WidgetRegistry, type WidgetDefinition } from './widget-registry'

const builtin = { kind: 'builtin' as const }

describe('CommandRegistry', () => {
  it('支持注册、读取、更新、列出和删除命令', async () => {
    const run = vi.fn()
    const registry = new CommandRegistry<{ value: number }>()

    registry.register({
      id: 'test.command',
      title: 'command.test',
      category: 'test',
      source: builtin,
      run
    })

    expect(registry.size).toBe(1)
    expect(registry.get('test.command')?.title).toBe('command.test')
    expect(registry.list().map((item) => item.id)).toEqual(['test.command'])

    const updated = registry.update('test.command', { title: 'command.test.updated' })
    expect(updated.title).toBe('command.test.updated')
    await registry.require('test.command').run({ value: 1 })
    expect(run).toHaveBeenCalledWith({ value: 1 })

    expect(registry.unregister('test.command')).toBe(true)
    expect(registry.unregister('test.command')).toBe(false)
    expect(registry.size).toBe(0)
  })

  it('拒绝重复 id，避免后注册功能静默覆盖已有命令', () => {
    const registry = new CommandRegistry()
    const definition = {
      id: 'test.duplicate',
      title: 'command.duplicate',
      category: 'test',
      source: builtin,
      run: () => undefined
    }
    registry.register(definition)
    expect(() => registry.register(definition)).toThrow(/duplicate registry id/i)
  })
})

describe('ViewRegistry', () => {
  it('支持视图 CRUD 并保留声明来源', () => {
    const registry = new ViewRegistry<{ name: string }, string>()
    registry.register({
      id: 'test.view',
      title: 'view.test',
      placement: 'main',
      source: { kind: 'plugin', pluginId: 'example-plugin' },
      render: ({ name }) => name
    })

    expect(registry.require('test.view').render({ name: 'Swob' })).toBe('Swob')
    expect(registry.require('test.view').source).toEqual({
      kind: 'plugin',
      pluginId: 'example-plugin'
    })
    expect(registry.update('test.view', { placement: 'overlay' }).placement).toBe('overlay')
    expect(registry.unregister('test.view')).toBe(true)
  })

  it('拒绝重复视图 id', () => {
    const registry = new ViewRegistry<unknown, null>()
    const definition = {
      id: 'test.view',
      title: 'view.test',
      placement: 'main' as const,
      source: builtin,
      render: () => null
    }
    registry.register(definition)
    expect(() => registry.register(definition)).toThrow(/duplicate registry id/i)
  })
})

describe('WidgetRegistry', () => {
  it('支持卡片 CRUD、page 查询和尺寸约束声明', () => {
    const registry = new WidgetRegistry<{ value: number }, number>()
    const definition: WidgetDefinition<{ value: number }, number> = {
      id: 'test.widget',
      title: 'widget.test',
      page: 'overview',
      source: builtin,
      dataScope: { kind: 'insights', dimensions: ['global'] },
      size: { minWidth: 3, defaultWidth: 6, maxWidth: 12 },
      render: ({ value }) => value
    }
    registry.register(definition)

    expect(registry.listByPage('overview').map((item) => item.id)).toEqual(['test.widget'])
    expect(registry.require('test.widget').render({ value: 7 })).toBe(7)
    definition.size.defaultWidth = 10
    expect(registry.require('test.widget').size.defaultWidth).toBe(6)
    expect(registry.update('test.widget', {
      size: { minWidth: 4, defaultWidth: 8, maxWidth: 12 }
    }).size.defaultWidth).toBe(8)
    expect(registry.unregister('test.widget')).toBe(true)
  })

  it('拒绝重复卡片 id', () => {
    const registry = new WidgetRegistry<unknown, null>()
    const definition = {
      id: 'test.widget',
      title: 'widget.test',
      page: 'overview',
      source: builtin,
      dataScope: { kind: 'none' as const },
      size: { minWidth: 1, defaultWidth: 1, maxWidth: 1 },
      render: () => null
    }
    registry.register(definition)
    expect(() => registry.register(definition)).toThrow(/duplicate registry id/i)
  })
})
