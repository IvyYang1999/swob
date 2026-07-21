import { describe, expect, it, vi } from 'vitest'
import {
  buildSmartOrganizationPrompt,
  parseSmartOrganizationResponse,
  requestSmartOrganization
} from './smart-organizer'

describe('智能整理 LLM 边界', () => {
  it('只发送标题和摘要级信息，不发送 transcript，并复用现有分类树', () => {
    const prompt = buildSmartOrganizationPrompt([{
      sessionId: 's1',
      title: '修复搜索性能',
      summary: '排查 SQLite FTS 延迟',
      transcript: '绝不能进入 LLM 的完整逐字稿'
    } as any], ['工程/性能', '产品/设计'])

    expect(prompt.userPrompt).toContain('修复搜索性能')
    expect(prompt.userPrompt).toContain('排查 SQLite FTS 延迟')
    expect(prompt.userPrompt).toContain('工程/性能')
    expect(prompt.userPrompt).not.toContain('完整逐字稿')
  })

  it('标题和摘要在进入请求前经过敏感信息脱敏', () => {
    const syntheticCredential = ['sk', 'ant', 'api03', 'a'.repeat(48)].join('-')
    const prompt = buildSmartOrganizationPrompt([{
      sessionId: 's1',
      title: `检查 ${syntheticCredential}`,
      summary: '只允许脱敏后的摘要'
    }], [])

    expect(prompt.userPrompt).not.toContain(syntheticCredential)
  })

  it('严格过滤未知 session、非法目录，并规范 tags 与置信度', () => {
    const parsed = parseSmartOrganizationResponse(`\n\`\`\`json\n[
      {"sessionId":"s1","folder":"工程/性能","topic":"性能优化","tags":["性能"," Electron ","性能"],"confidence":1.2},
      {"sessionId":"unknown","folder":"泄漏","topic":"未知","tags":[],"confidence":0.8},
      {"sessionId":"s2","folder":"../逃逸","topic":"危险","tags":[],"confidence":0.2}
    ]\n\`\`\``, new Set(['s1', 's2']))

    expect(parsed).toEqual([{
      sessionId: 's1',
      folder: '工程/性能',
      topic: '性能优化',
      tags: ['性能', 'Electron'],
      confidence: 1
    }])
  })

  it('请求函数把结构化建议返回给调用方，不在预览阶段写盘', async () => {
    const call = vi.fn().mockResolvedValue('[{"sessionId":"s1","folder":"产品","topic":"需求","tags":["产品"],"confidence":0.9}]')
    const result = await requestSmartOrganization(
      { provider: 'openai', apiKey: ['unit', 'test'].join('-'), model: 'test' },
      [{ sessionId: 's1', title: '需求讨论', summary: '确定 Vault 模型' }],
      ['工程'],
      call
    )

    expect(call).toHaveBeenCalledOnce()
    expect(result).toEqual([{
      sessionId: 's1', folder: '产品', topic: '需求', tags: ['产品'], confidence: 0.9
    }])
  })
})
