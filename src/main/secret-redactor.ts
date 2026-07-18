export interface RedactionResult {
  text: string
  hits: number
}

interface TextRange {
  start: number
  end: number
}

const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi
const GIT_SHA_RE = /\b[0-9a-f]{40}\b/gi
const DATA_IMAGE_RE = /data:image[^\s)\]]*/gi
const MARKDOWN_LINK_DESTINATION_RE = /\]\(\s*(?:<([^>]+)>|([^\s)]+))/g
const DATABASE_PASSWORD_RE = /\b((?:[a-z]+sql?|rediss?|mongodb(?:\+srv)?):\/\/[^:/\s]+:)([^@\s]+)(@)/gi
const CREDENTIAL_RE = new RegExp([
  '-----BEGIN [A-Z ]*PRI[V]ATE KEY-----[\\s\\S]*?-----END [A-Z ]*PRI[V]ATE KEY-----',
  's[k]-[A-Za-z0-9_-]{20,}',
  'g[h]p_[A-Za-z0-9]{36}',
  'g[h]o_[A-Za-z0-9]{36}',
  'g[i]thub_pat_[A-Za-z0-9_]{22,}',
  'x[o]x[bprs]-[A-Za-z0-9-]{10,}',
  'A[K]IA[0-9A-Z]{16}',
  'A[I]za[0-9A-Za-z_-]{35}',
  'y[a]29\\.[0-9A-Za-z_-]{20,}',
  '\\be[y]J[A-Za-z0-9_-]{20,}\\.[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}\\b',
  '\\b[A-Z]{2}[0-9A-Za-z_-]{30,}\\b'
].join('|'), 'g')

function addMatches(ranges: TextRange[], text: string, re: RegExp): void {
  re.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = re.exec(text)) !== null) ranges.push({ start: match.index, end: match.index + match[0].length })
}

function protectedRanges(text: string): TextRange[] {
  const ranges: TextRange[] = []
  addMatches(ranges, text, UUID_RE)
  addMatches(ranges, text, GIT_SHA_RE)
  addMatches(ranges, text, DATA_IMAGE_RE)
  MARKDOWN_LINK_DESTINATION_RE.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = MARKDOWN_LINK_DESTINATION_RE.exec(text)) !== null) {
    const destination = match[1] || match[2]
    if (!destination) continue
    const offset = match[0].lastIndexOf(destination)
    ranges.push({ start: match.index + offset, end: match.index + offset + destination.length })
  }
  return ranges
}

function visiblePrefix(candidate: string): string {
  if (/^(?:s[k]-|g[h][po]_|x[o]x[bprs]-|A[K]IA|A[I]za|y[a]29\.)/.test(candidate)) return candidate.slice(0, 4)
  return candidate.slice(0, 2)
}

function redactDatabasePasswords(text: string): RedactionResult {
  let hits = 0
  DATABASE_PASSWORD_RE.lastIndex = 0
  const redacted = text.replace(
    DATABASE_PASSWORD_RE,
    (candidate: string, prefix: string, password: string, suffix: string) => {
      if (password.endsWith('（已脱敏）')) return candidate
      hits++
      const visibleSuffix = password.length > 4 ? password.slice(-4) : ''
      return `${prefix}xx……${visibleSuffix}（已脱敏）${suffix}`
    }
  )
  return { text: redacted, hits }
}

function isProtected(start: number, end: number, ranges: TextRange[]): boolean {
  return ranges.some((range) => start < range.end && end > range.start)
}

export function redactSecrets(text: string): RedactionResult {
  const databaseResult = redactDatabasePasswords(text)
  const ranges = protectedRanges(databaseResult.text)
  let hits = databaseResult.hits
  const redacted = databaseResult.text.replace(CREDENTIAL_RE, (candidate: string, offset: number) => {
    if (isProtected(offset, offset + candidate.length, ranges)) return candidate
    hits++
    return `${visiblePrefix(candidate)}……${candidate.slice(-4)}（已脱敏）`
  })
  return { text: redacted, hits }
}
