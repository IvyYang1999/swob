// swob chat-format —— framework-agnostic 对话解析/清洗层。可被外部 vendor（像素office 等），修改需同步。

/**
 * Remove terminal control sequences before text reaches Markdown, search,
 * clipboard, or a derived transcript. Handles CSI (including SGR/cursor/
 * screen controls), OSC hyperlinks/titles terminated by BEL or ST, C1
 * equivalents, and unterminated OSC payloads up to the next line boundary.
 */
export function stripTerminalControlSequences(text: string): string {
  if (!text) return ''
  return text
    // OSC: ESC ] ... BEL/ST and its C1 equivalent.
    .replace(/\u001B\][^\u0007\u001B\r\n]*(?:\u0007|\u001B\\)/g, '')
    .replace(/\u009D[^\u0007\u009C\r\n]*(?:\u0007|\u009C)/g, '')
    // An incomplete OSC must not leak its payload; stop at the line boundary.
    // This must run before the generic two-byte ESC pass consumes ESC ].
    .replace(/\u001B\][^\r\n]*(?:\r?\n|$)/g, '')
    .replace(/\u009D[^\r\n]*(?:\r?\n|$)/g, '')
    // DCS, SOS, PM and APC strings, terminated by ST.
    .replace(/\u001B[PX^_][\s\S]*?(?:\u001B\\|\u009C)/g, '')
    // CSI: parameters, intermediates, then a final byte.
    .replace(/(?:\u001B\[|\u009B)[0-?]*[ -/]*[@-~]/g, '')
    // Character-set selection and remaining two-byte ESC commands.
    .replace(/\u001B[()][0-2A-Z]/g, '')
    .replace(/\u001B[@-_]/g, '')
    // Drop standalone C1 controls left after the structured passes above.
    .replace(/[\u0090-\u009F]/g, '')
}

/** Recursively clean terminal text carried in structured tool inputs/results. */
export function stripTerminalControlSequencesDeep<T>(value: T): T {
  if (typeof value === 'string') return stripTerminalControlSequences(value) as T
  if (Array.isArray(value)) {
    return value.map((item) => stripTerminalControlSequencesDeep(item)) as T
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .map(([key, item]) => [key, stripTerminalControlSequencesDeep(item)])
    ) as T
  }
  return value
}

/** Strip system-injected XML blocks and wrappers from user message text. */
export function stripUserText(text: string): string {
  let result = stripTerminalControlSequences(text)
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>\s*/g, '')
    .replace(/<available-deferred-tools>[\s\S]*?<\/available-deferred-tools>\s*/g, '')

  // Cursor wraps user input in <user_query>.
  const userQueryMatch = result.match(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/)
  if (userQueryMatch) result = userQueryMatch[1]

  result = result
    .replace(/<user_info>[\s\S]*?<\/user_info>\s*/g, '')
    .replace(/<git_status>[\s\S]*?<\/git_status>\s*/g, '')
    .replace(/<attached_files>[\s\S]*?<\/attached_files>\s*/g, '')
    .replace(/<agent_transcripts>[\s\S]*?<\/agent_transcripts>\s*/g, '')
    .replace(/<agent_skills>[\s\S]*?<\/agent_skills>\s*/g, '')
    .replace(/<rules>[\s\S]*?<\/rules>\s*/g, '')
    .replace(/^\[Image(?:\s*#\d+)?\]\s*/g, '')

  return result.trim()
}

/** Extract `[Image: source: /path]` entries and the remaining display text. */
export function splitImagePaths(text: string): { displayText: string; imagePaths: string[] } {
  const imagePaths: string[] = []
  const displayText = stripTerminalControlSequences(text).replace(/\[Image: source: ([^\]]+)\]\s*/g, (_match, imagePath: string) => {
    imagePaths.push(imagePath.trim())
    return ''
  }).trim()

  return { displayText, imagePaths }
}

/** Parse command-output text, including merged consecutive system messages. */
export function parseCommandOutput(text: string): { label: string; output: string } {
  const normalized = stripTerminalControlSequences(text)
  const commandName = normalized.match(/<command-name>(.*?)<\/command-name>/)?.[1]
  const stdout = normalized.match(/<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/)?.[1]?.trim()
  const hookOutput = normalized.match(/<user-prompt-submit-hook>([\s\S]*?)<\/user-prompt-submit-hook>/)?.[1]?.trim()
  const output = stdout || hookOutput || ''

  if (commandName) return { label: commandName, output }
  if (output) return { label: 'Terminal', output }
  return { label: 'System', output: normalized.replace(/<[^>]+>/g, '').trim() }
}
