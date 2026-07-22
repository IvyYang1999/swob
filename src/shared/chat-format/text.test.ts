import { describe, expect, it } from 'vitest'
import {
  parseCommandOutput,
  splitImagePaths,
  stripTerminalControlSequences,
  stripUserText
} from './text'

describe('stripTerminalControlSequences', () => {
  it('统一移除 SGR、光标/清屏 CSI 与 BEL/ST 终止的 OSC', () => {
    const input = [
      '\u001b[2m灰色\u001b[22m',
      '\u001b[2J\u001b[1;1H正文',
      '\u001b]8;;https://example.com\u0007链接\u001b]8;;\u0007',
      '\u001b]0;窗口标题\u001b\\保留'
    ].join('|')

    expect(stripTerminalControlSequences(input)).toBe('灰色|正文|链接|保留')
  })

  it('移除 C1 CSI/OSC 和未终止 OSC，不吞掉下一行正常文本', () => {
    expect(stripTerminalControlSequences('\u009b31m红\u009b0m|\u009d0;标题\u009c正文'))
      .toBe('红|正文')
    expect(stripTerminalControlSequences('前\u001b]0;坏标题\n后')).toBe('前后')
  })
})

describe('stripUserText', () => {
  it('strips Claude system-reminder blocks wherever they appear', () => {
    expect(stripUserText('before\n<system-reminder>secret\ncontext</system-reminder>\nafter'))
      .toBe('before\nafter')
  })

  it('strips available-deferred-tools blocks', () => {
    expect(stripUserText('<available-deferred-tools>Read, Write</available-deferred-tools>\nquestion'))
      .toBe('question')
  })

  it('unwraps the Cursor user_query and excludes surrounding injected context', () => {
    const text = '<user_info>private context</user_info>\n<user_query>\nactual question\n</user_query>\n<git_status>dirty</git_status>'
    expect(stripUserText(text)).toBe('actual question')
  })

  it.each([
    'user_info',
    'git_status',
    'attached_files',
    'agent_transcripts',
    'agent_skills',
    'rules'
  ])('strips <%s> injection blocks', (tag) => {
    expect(stripUserText(`<${tag}>injected</${tag}>\nvisible`)).toBe('visible')
  })

  it('strips bare image prefixes while retaining source-path image markers', () => {
    expect(stripUserText('[Image #2] question')).toBe('question')
    expect(stripUserText('[Image: source: /tmp/image.png] question'))
      .toBe('[Image: source: /tmp/image.png] question')
  })

  it('在用户文本规范化入口移除终端控制序列', () => {
    expect(stripUserText('\u001b[33m警告\u001b[0m')).toBe('警告')
  })
})

describe('splitImagePaths', () => {
  it('collects multiple paths in order and removes their markers', () => {
    expect(splitImagePaths('[Image: source: /tmp/a.png] hello [Image: source: /tmp/b.jpg] world'))
      .toEqual({ displayText: 'hello world', imagePaths: ['/tmp/a.png', '/tmp/b.jpg'] })
  })
})

describe('parseCommandOutput', () => {
  it('uses a slash command as label and stdout as output', () => {
    expect(parseCommandOutput('<command-name>/login</command-name><local-command-stdout> done </local-command-stdout>'))
      .toEqual({ label: '/login', output: 'done' })
  })

  it('labels standalone hook output as Terminal', () => {
    expect(parseCommandOutput('<user-prompt-submit-hook> checked </user-prompt-submit-hook>'))
      .toEqual({ label: 'Terminal', output: 'checked' })
  })

  it('falls back to tag-free System text', () => {
    expect(parseCommandOutput('<caveat>notice</caveat>')).toEqual({ label: 'System', output: 'notice' })
  })
})
