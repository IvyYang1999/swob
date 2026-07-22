import { describe, expect, it } from 'vitest'
import { assertRegisteredResumeProtocol } from './deep-link'

describe('Windows Resume deep link', () => {
  it('Codex 协议未注册时 fail closed', () => {
    expect(() => assertRegisteredResumeProtocol('codex:', '', 'win32'))
      .toThrow('未检测到可处理 codex: 的 Codex/ChatGPT App')
  })

  it('Windows 只接受 Codex/ChatGPT 处理 codex 协议', () => {
    expect(() => assertRegisteredResumeProtocol('codex:', 'ChatGPT', 'win32')).not.toThrow()
    expect(() => assertRegisteredResumeProtocol('codex:', 'ChatGPT.exe', 'win32')).not.toThrow()
    expect(() => assertRegisteredResumeProtocol('codex:', 'Unknown Browser', 'win32'))
      .toThrow('非官方应用')
  })
})
