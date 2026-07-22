/**
 * Privacy utilities for share image rendering.
 *
 * Defaults are privacy-first:
 * - Session IDs: excluded
 * - Absolute paths: stripped
 * - Tool results / error text: excluded
 * - Basic secret pattern detection before export
 */

/** Patterns that look like secrets — API keys, tokens, passwords. */
const SECRET_PATTERNS = [
  // Generic API key patterns
  /(?:api[_-]?key|apikey|secret[_-]?key|access[_-]?token|auth[_-]?token|bearer)\s*[:=]\s*["']?[A-Za-z0-9_\-/.]{16,}/gi,
  // AWS-style keys
  /AKIA[0-9A-Z]{16}/g,
  // sk- prefixed (OpenAI / Anthropic)
  /sk-[A-Za-z0-9_\-]{20,}/g,
  // GitHub tokens
  /gh[pous]_[A-Za-z0-9_]{36,}/g,
  // Bearer tokens in text
  /Bearer\s+[A-Za-z0-9_\-/.+=]{20,}/g,
  // Private keys
  /-----BEGIN\s+(RSA\s+)?PRIVATE\s+KEY-----/g,
  // Password assignments
  /(?:password|passwd|pwd)\s*[:=]\s*["']?[^\s"']{8,}/gi,
]

/** Absolute path pattern (Unix & Windows) */
const ABSOLUTE_PATH_RE = /(?:\/(?:Users|home|var|tmp|etc|opt|private|mnt|srv|root|Applications)\/[^\s"'`)}\]]+|[A-Z]:\\[^\s"'`)}\]]+)/g

/** UUID-like session ID pattern */
const SESSION_ID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi

export interface PrivacyOptions {
  /** Strip absolute file paths (default: true) */
  stripPaths: boolean
  /** Strip session IDs (default: true) */
  stripSessionIds: boolean
  /** Exclude tool results / error text from output (default: true) */
  excludeToolResults: boolean
}

export const DEFAULT_PRIVACY: PrivacyOptions = {
  stripPaths: true,
  stripSessionIds: true,
  excludeToolResults: true,
}

/**
 * Scan text for potential secrets. Returns a list of detected patterns
 * (descriptions, not the actual secret values).
 */
export function detectSecrets(text: string): string[] {
  const found: string[] = []
  for (const pattern of SECRET_PATTERNS) {
    pattern.lastIndex = 0
    if (pattern.test(text)) {
      found.push(pattern.source.slice(0, 30) + '...')
    }
    pattern.lastIndex = 0
  }
  return found
}

/**
 * Sanitize text according to privacy settings.
 */
export function sanitizeText(text: string, options: PrivacyOptions): string {
  let result = text
  if (options.stripPaths) {
    result = result.replace(ABSOLUTE_PATH_RE, '<path>')
  }
  if (options.stripSessionIds) {
    result = result.replace(SESSION_ID_RE, '<session-id>')
  }
  return result
}
