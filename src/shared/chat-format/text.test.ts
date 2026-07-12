import { describe, expect, it } from 'vitest'
import { parseCommandOutput, splitImagePaths, stripUserText } from './text'

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
