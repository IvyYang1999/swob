function validResumeSessionId(value: string | undefined): value is string {
  if (!value || value.startsWith('-') || value.startsWith('=')) return false
  return !/["'`]/.test(value)
}

export function parseActiveClaudeSessionIds(processCommands: string): Set<string> {
  const active = new Set<string>()
  for (const line of processCommands.split('\n')) {
    if (!line.includes('claude')) continue
    const tokens = line.trim().split(/\s+/)
    for (let index = 0; index < tokens.length; index++) {
      const token = tokens[index]
      if (token === '--resume') {
        const sessionId = tokens[index + 1]
        if (validResumeSessionId(sessionId)) active.add(sessionId)
        continue
      }
      if (!token.startsWith('--resume=')) continue
      const sessionId = token.slice('--resume='.length)
      if (validResumeSessionId(sessionId)) active.add(sessionId)
    }
  }
  return active
}
