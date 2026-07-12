// swob chat-format —— framework-agnostic 对话解析/清洗层。可被外部 vendor（像素office 等），修改需同步。

/** Strip system-injected XML blocks and wrappers from user message text. */
export function stripUserText(text: string): string {
  let result = text
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
  const displayText = text.replace(/\[Image: source: ([^\]]+)\]\s*/g, (_match, imagePath: string) => {
    imagePaths.push(imagePath.trim())
    return ''
  }).trim()

  return { displayText, imagePaths }
}

/** Parse command-output text, including merged consecutive system messages. */
export function parseCommandOutput(text: string): { label: string; output: string } {
  const commandName = text.match(/<command-name>(.*?)<\/command-name>/)?.[1]
  const stdout = text.match(/<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/)?.[1]?.trim()
  const hookOutput = text.match(/<user-prompt-submit-hook>([\s\S]*?)<\/user-prompt-submit-hook>/)?.[1]?.trim()
  const output = stdout || hookOutput || ''

  if (commandName) return { label: commandName, output }
  if (output) return { label: 'Terminal', output }
  return { label: 'System', output: text.replace(/<[^>]+>/g, '').trim() }
}
