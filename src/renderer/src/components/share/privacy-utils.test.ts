import { describe, expect, it } from 'vitest'
import { detectSecrets, sanitizeText, DEFAULT_PRIVACY } from './privacy-utils'
import type { PrivacyOptions } from './privacy-utils'

describe('detectSecrets', () => {
  it('detects API key patterns', () => {
    const text = 'api_key: sk-abc123456789012345678901234567890123'
    const results = detectSecrets(text)
    expect(results.length).toBeGreaterThan(0)
  })

  it('detects AWS access keys', () => {
    const text = 'AKIAIOSFODNN7EXAMPLE'
    const results = detectSecrets(text)
    expect(results.length).toBeGreaterThan(0)
  })

  it('detects GitHub tokens', () => {
    const text = 'ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789'
    const results = detectSecrets(text)
    expect(results.length).toBeGreaterThan(0)
  })

  it('detects Bearer tokens', () => {
    const text = 'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.signature'
    const results = detectSecrets(text)
    expect(results.length).toBeGreaterThan(0)
  })

  it('returns empty for safe text', () => {
    const text = 'Hello, how do I sort an array in JavaScript?'
    const results = detectSecrets(text)
    expect(results).toEqual([])
  })

  it('detects password assignments', () => {
    const text = 'password=MySuperSecretPassword123'
    const results = detectSecrets(text)
    expect(results.length).toBeGreaterThan(0)
  })

  it('detects private key headers', () => {
    const text = '-----BEGIN PRIVATE KEY-----\nMIIEvQ...'
    const results = detectSecrets(text)
    expect(results.length).toBeGreaterThan(0)
  })
})

describe('sanitizeText', () => {
  it('strips absolute Unix paths when enabled', () => {
    const text = 'Edited /Users/john/projects/myapp/src/main.ts'
    const result = sanitizeText(text, { ...DEFAULT_PRIVACY, stripPaths: true })
    expect(result).toBe('Edited <path>')
    expect(result).not.toContain('/Users/john')
  })

  it('preserves text when path stripping is disabled', () => {
    const text = 'Edited /Users/john/projects/myapp/src/main.ts'
    const result = sanitizeText(text, { ...DEFAULT_PRIVACY, stripPaths: false })
    expect(result).toContain('/Users/john')
  })

  it('strips session IDs when enabled', () => {
    const text = 'Session: a1b2c3d4-e5f6-7890-abcd-ef1234567890'
    const result = sanitizeText(text, { ...DEFAULT_PRIVACY, stripSessionIds: true })
    expect(result).toBe('Session: <session-id>')
    expect(result).not.toContain('a1b2c3d4')
  })

  it('preserves session IDs when stripping is disabled', () => {
    const text = 'Session: a1b2c3d4-e5f6-7890-abcd-ef1234567890'
    const result = sanitizeText(text, { ...DEFAULT_PRIVACY, stripSessionIds: false })
    expect(result).toContain('a1b2c3d4')
  })

  it('handles multiple paths in one string', () => {
    const text = 'Read /Users/alice/file.ts then wrote /home/bob/out.js'
    const result = sanitizeText(text, { ...DEFAULT_PRIVACY, stripPaths: true })
    expect(result).toBe('Read <path> then wrote <path>')
  })

  it('handles empty text', () => {
    const result = sanitizeText('', DEFAULT_PRIVACY)
    expect(result).toBe('')
  })

  it('applies both path and session ID stripping simultaneously', () => {
    const text = 'File: /Users/dev/app.ts Session: 12345678-1234-1234-1234-123456789abc'
    const result = sanitizeText(text, {
      stripPaths: true,
      stripSessionIds: true,
      excludeToolResults: true,
    })
    expect(result).toBe('File: <path> Session: <session-id>')
  })
})

describe('DEFAULT_PRIVACY', () => {
  it('has privacy-first defaults', () => {
    expect(DEFAULT_PRIVACY.stripPaths).toBe(true)
    expect(DEFAULT_PRIVACY.stripSessionIds).toBe(true)
    expect(DEFAULT_PRIVACY.excludeToolResults).toBe(true)
  })
})
