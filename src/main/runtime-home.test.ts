import { describe, expect, it } from 'vitest'
import { resolveRuntimeHome } from './runtime-home'

describe('resolveRuntimeHome', () => {
  it('Windows 生产环境使用 os.homedir 的 USERPROFILE 语义', () => {
    expect(resolveRuntimeHome({
      platform: 'win32',
      nodeEnv: 'production',
      env: { HOME: 'D:\\git-bash-home', USERPROFILE: 'C:\\Users\\Alice' },
      osHome: 'C:\\Users\\Alice'
    })).toBe('C:\\Users\\Alice')
  })

  it('测试环境仍允许 HOME fixture 隔离真实用户目录', () => {
    expect(resolveRuntimeHome({
      platform: 'win32',
      nodeEnv: 'test',
      env: { HOME: 'C:\\fixture-home', USERPROFILE: 'C:\\Users\\Alice' },
      osHome: 'C:\\Users\\Alice'
    })).toBe('C:\\fixture-home')
  })

  it('macOS 生产环境保留现有 HOME 优先级', () => {
    expect(resolveRuntimeHome({
      platform: 'darwin',
      nodeEnv: 'production',
      env: { HOME: '/Volumes/managed-home' },
      osHome: '/Users/alice'
    })).toBe('/Volumes/managed-home')
  })
})
