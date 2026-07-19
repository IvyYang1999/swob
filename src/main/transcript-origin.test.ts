import { describe, expect, it } from 'vitest'
import type { RawJsonlMessage } from './types'
import { detectTranscriptOrigin, formatTranscriptOriginHeader } from './transcript-origin'

function userMessage(
  content: NonNullable<RawJsonlMessage['message']>['content'],
  fields: Partial<RawJsonlMessage> = {}
): RawJsonlMessage {
  return {
    uuid: fields.uuid || 'sample-user',
    parentUuid: fields.parentUuid ?? null,
    sessionId: fields.sessionId || 'sample-session',
    type: 'user',
    timestamp: fields.timestamp || '2026-07-19T00:00:00Z',
    version: fields.version || '2.1.201',
    message: { role: 'user', content },
    ...fields
  }
}

describe('transcript 来源判定', () => {
  it('真人：优先采用 origin.kind human，并兼容旧版普通 content', () => {
    const typed = userMessage('帮我核对 transcript', {
      origin: { kind: 'human' },
      promptSource: 'typed'
    })
    const legacyArray = userMessage([
      { type: 'text', text: '请看这张图' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'redacted' } }
    ])

    expect(detectTranscriptOrigin(typed)).toBe('human')
    expect(detectTranscriptOrigin(legacyArray)).toBe('human')
  })

  it('task-notification：结构字段优先，并兼容旧版起始标签', () => {
    const structured = userMessage('通知正文无需参与判定', {
      origin: { kind: 'task-notification' },
      promptSource: 'system'
    })
    const legacy = userMessage('<task-notification>后台任务完成</task-notification>')

    expect(detectTranscriptOrigin(structured)).toBe('task-notification')
    expect(detectTranscriptOrigin(legacy)).toBe('task-notification')
  })

  it('hook：识别两种已知的起始包装', () => {
    const reminder = userMessage('<system-reminder>hook 注入</system-reminder>', { isMeta: true })
    const submitHook = userMessage('<user-prompt-submit-hook>checked</user-prompt-submit-hook>', { isMeta: true })

    expect(detectTranscriptOrigin(reminder)).toBe('hook')
    expect(detectTranscriptOrigin(submitHook)).toBe('hook')
  })

  it('command：识别本地命令输出及本机实见的 bash 包装', () => {
    const caveat = userMessage('<local-command-caveat>generated locally</local-command-caveat>', { isMeta: true })
    const bashStdout = userMessage('<bash-stdout>command output</bash-stdout>')

    expect(detectTranscriptOrigin(caveat)).toBe('command')
    expect(detectTranscriptOrigin(bashStdout)).toBe('command')
  })

  it('tool：tool_result 单独或与 text 混合都优先判为工具载体', () => {
    const result = userMessage([{ type: 'tool_result', tool_use_id: 'tool-1', content: 'ok' }])
    const mixed = userMessage([
      { type: 'tool_result', tool_use_id: 'tool-2', content: 'answer' },
      { type: 'text', text: 'answer' }
    ])

    expect(detectTranscriptOrigin(result)).toBe('tool')
    expect(detectTranscriptOrigin(mixed)).toBe('tool')
  })

  it('unknown：机器元消息和 compact continuation 绝不默认归 human', () => {
    const skillMeta = userMessage([{ type: 'text', text: 'Base directory for this skill: /redacted' }], { isMeta: true })
    const continuation = userMessage('This session is being continued from a previous conversation. Summary: redacted')
    const futureMachineWrapper = userMessage('<future-machine-message>generated</future-machine-message>')

    expect(detectTranscriptOrigin(skillMeta)).toBe('unknown')
    expect(detectTranscriptOrigin(continuation)).toBe('unknown')
    expect(detectTranscriptOrigin(futureMachineWrapper)).toBe('unknown')
  })

  it('【曾经的 bug】正文中途引用 task-notification 字样仍是真人消息', () => {
    const quoted = userMessage('请解释正文里的 <task-notification> 字样')

    expect(detectTranscriptOrigin(quoted)).toBe('human')
  })

  it('结构化字段优先于标签，未知结构值也不回退猜测', () => {
    const humanQuote = userMessage('<task-notification>这是用户引用的样例</task-notification>', {
      origin: { kind: 'human' }
    })
    const futureKind = userMessage('<task-notification>外形像任务通知</task-notification>', {
      origin: { kind: 'future-kind' }
    })

    expect(detectTranscriptOrigin(humanQuote)).toBe('human')
    expect(detectTranscriptOrigin(futureKind)).toBe('unknown')
  })

  it('文本标头：真人不添加，机器与 unknown 使用统一文案', () => {
    expect(formatTranscriptOriginHeader('human')).toBeNull()
    expect(formatTranscriptOriginHeader('command')).toBe('〔机器注入 · command〕')
    expect(formatTranscriptOriginHeader('unknown')).toBe('〔来源未判定〕')
  })

  it('其它 harness 即使外形相同也诚实降级 unknown', () => {
    const message = userMessage('<task-notification>done</task-notification>')

    expect(detectTranscriptOrigin(message, 'codex')).toBe('unknown')
    expect(detectTranscriptOrigin(message, 'cursor')).toBe('unknown')
  })
})
