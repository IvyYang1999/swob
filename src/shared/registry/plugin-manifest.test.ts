import { describe, expect, it } from 'vitest'
import {
  DisabledSwobPluginLoader,
  SWOB_PLUGIN_EXECUTION_ENABLED,
  isSwobPluginManifest
} from './plugin-manifest'

describe('插件 manifest 预研占位', () => {
  it('feature flag 永久关闭，加载器拒绝执行任何外部插件', async () => {
    expect(SWOB_PLUGIN_EXECUTION_ENABLED).toBe(false)
    const loader = new DisabledSwobPluginLoader()
    await expect(loader.load({
      id: 'example-plugin',
      name: 'Example',
      version: '1.0.0',
      apiVersion: 1,
      minAppVersion: '1.2.0',
      entry: 'main.js'
    })).rejects.toThrow(/plugin execution is disabled/i)
  })

  it('只接受最小合法 manifest 形状', () => {
    expect(isSwobPluginManifest({
      id: 'example-plugin',
      name: 'Example',
      version: '1.0.0',
      apiVersion: 1,
      minAppVersion: '1.2.0',
      entry: 'main.js'
    })).toBe(true)
    expect(isSwobPluginManifest({ id: 'Example Plugin' })).toBe(false)
    expect(isSwobPluginManifest({
      id: 'unsafe-plugin', name: 'Unsafe', version: '1.0.0', apiVersion: 1,
      minAppVersion: '1.2.0', entry: '../outside.js'
    })).toBe(false)
  })
})
