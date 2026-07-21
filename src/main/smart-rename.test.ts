import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  SmartRenameService,
  buildSmartRenamePrompt,
  requestSmartRename
} from './smart-rename'
import { LlmProfileError } from './llm-profiles'

const settings = { provider: 'openai' as const, credential: 'runtime-fixture', model: 'fixture-model' }
const candidates = [{
  id: 'session-1',
  oldTitle: '旧标题',
  firstUserMessage: '帮我修复搜索索引',
  conversationSummary: '用户要求定位增量索引重复写入，助手检查了同步队列'
}]

let root = ''

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-smart-rename-'))
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe('智能重命名', () => {
  it('只发送截断且脱敏的会话片段，并要求严格 titles JSON', () => {
    const syntheticCredential = ['sk', 'ant', 'api03', 'a'.repeat(48)].join('-')
    const prompt = buildSmartRenamePrompt([{
      ...candidates[0],
      conversationSummary: `排查 ${syntheticCredential}`
    }])

    expect(prompt.userPrompt).toContain('帮我修复搜索索引')
    expect(prompt.userPrompt).not.toContain(syntheticCredential)
    expect(prompt.systemPrompt).toContain('{"titles"')
    expect(prompt.systemPrompt).toContain('不超过 30 个字')
  })

  it('preview 只返回旧名和新名，不触发落盘；apply 才写 custom title', async () => {
    const diskPath = path.join(root, 'custom-title.json')
    const setCustomTitle = vi.fn((id: string, title: string) => {
      fs.writeFileSync(diskPath, JSON.stringify({ id, customTitle: title }))
    })
    const service = new SmartRenameService({
      resolveProfile: async () => settings,
      loadCandidates: async () => candidates,
      setCustomTitle,
      call: vi.fn().mockResolvedValue('{"titles":{"session-1":"修复搜索索引重复写入"}}')
    })

    await expect(service.preview(['session-1'])).resolves.toEqual([{
      id: 'session-1', oldTitle: '旧标题', newTitle: '修复搜索索引重复写入'
    }])
    expect(setCustomTitle).not.toHaveBeenCalled()
    expect(fs.existsSync(diskPath)).toBe(false)

    await expect(service.apply([{ id: 'session-1', newTitle: '修复搜索索引重复写入' }]))
      .resolves.toEqual([{ id: 'session-1', newTitle: '修复搜索索引重复写入' }])
    expect(JSON.parse(fs.readFileSync(diskPath, 'utf8'))).toEqual({
      id: 'session-1', customTitle: '修复搜索索引重复写入'
    })
  })

  it('JSON 解析失败时只重试一次，第二次合法则成功', async () => {
    const caller = vi.fn()
      .mockResolvedValueOnce('不是 JSON')
      .mockResolvedValueOnce('{"titles":{"session-1":"修复搜索索引"}}')

    await expect(requestSmartRename(settings, candidates, caller)).resolves.toEqual({
      'session-1': '修复搜索索引'
    })
    expect(caller).toHaveBeenCalledTimes(2)
    expect(caller.mock.calls[1][1]).toContain('最后一次机会')
  })

  it('连续两次无效 JSON 后返回结构化错误', async () => {
    const caller = vi.fn().mockResolvedValue('```json\n{}\n```')

    await expect(requestSmartRename(settings, candidates, caller)).rejects.toMatchObject({
      code: 'LLM_RESPONSE_INVALID'
    })
    expect(caller).toHaveBeenCalledTimes(2)
  })

  it('LLM 异常不透传上游响应或凭据文本', async () => {
    const caller = vi.fn().mockRejectedValue(new Error('upstream echoed runtime-fixture'))

    await expect(requestSmartRename(settings, candidates, caller)).rejects.toMatchObject({
      code: 'LLM_REQUEST_FAILED',
      message: '模型调用失败，请检查 Profile 配置或网络'
    })
  })

  it('未绑定 Profile 时返回可供渲染层展示的结构化错误', async () => {
    const service = new SmartRenameService({
      resolveProfile: async () => {
        throw new LlmProfileError('PROFILE_NOT_BOUND', '尚未绑定 LLM Profile')
      },
      loadCandidates: async () => candidates,
      setCustomTitle: vi.fn()
    })

    await expect(service.preview(['session-1'])).rejects.toMatchObject({
      code: 'PROFILE_NOT_BOUND',
      message: '尚未绑定 LLM Profile'
    })
  })
})
