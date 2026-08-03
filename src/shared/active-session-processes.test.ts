import { describe, expect, it } from 'vitest'
import { parseActiveClaudeSessionIds } from './active-session-processes'

describe('parseActiveClaudeSessionIds', () => {
  it('accepts space and equals forms and deduplicates session IDs', () => {
    const active = parseActiveClaudeSessionIds([
      '/opt/claude --resume session-space',
      '/opt/claude --resume=session-equals',
      '/opt/claude --resume=session-equals',
      '/opt/claude --resume session-trailing --verbose'
    ].join('\n'))

    expect([...active]).toEqual(['session-space', 'session-equals', 'session-trailing'])
  })

  it.each([
    '/opt/claude --resume',
    '/opt/claude --resume=',
    '/opt/claude --resume --verbose',
    '/opt/claude --resume=--verbose',
    '/opt/claude --resume-other session-other',
    '/opt/claude --resume "quoted-session"',
    "/opt/claude --resume='quoted-session'",
    '/opt/claude --resume==malformed'
  ])('rejects malformed resume input: %s', (command) => {
    expect(parseActiveClaudeSessionIds(command)).toEqual(new Set())
  })

  it('ignores matching flags on commands that are not Claude processes', () => {
    expect(parseActiveClaudeSessionIds('/opt/other --resume=session-other')).toEqual(new Set())
  })
})
