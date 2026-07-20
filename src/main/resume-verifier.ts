import { createHash } from 'node:crypto'
import { validateBackupJsonl, type BackupValidationOptions, type BackupValidationResult } from './backup-validator'
import { selectClaudeDefaultChain } from './claude-main-chain'
import { isRealUserMessage } from './session-message-classifier'
import type { ParsedMessage, RawJsonlMessage } from './types'

export { selectClaudeDefaultChain } from './claude-main-chain'

export interface ResumeAnchors {
  user: string
  assistant: string
}

export interface ResumeAnchorMessage {
  role: 'user' | 'assistant'
  text: string
}

export type ResumeL3MismatchKind = 'wrong-branch' | 'stale' | 'empty'

export interface ResumeL3TargetData {
  status: 'found' | 'empty' | 'missing' | 'unparseable'
  defaultMessages: ResumeAnchorMessage[]
  allMessages: ResumeAnchorMessage[]
}

export type ResumeL3Decision =
  | { status: 'match'; actualAnchors: ResumeAnchors }
  | { status: 'mismatch'; mismatchKind: ResumeL3MismatchKind; actualAnchors: ResumeAnchors }
  | { status: 'would-404'; actualAnchors: ResumeAnchors }
  | { status: 'skipped'; reason: 'expected-anchor-empty'; actualAnchors: ResumeAnchors }

export interface ResumeIntegrityEvidence {
  algorithm: 'sha256'
  sourceHash: string
  targetHash: string
  sourceBytes: number
  targetBytes: number
  byteEqual: boolean
  hashEqual: boolean
  matches: boolean
}

export interface ClaudeResumeVerificationResult {
  status: 'match' | 'mismatch' | 'invalid-source' | 'invalid-target'
  l3: ResumeL3Decision
  integrity: ResumeIntegrityEvidence
  sourceValidation: BackupValidationResult
  targetValidation: BackupValidationResult
}

function extractRawText(message: RawJsonlMessage): string {
  const content = message.message?.content
  if (!content) return ''
  if (typeof content === 'string') return content
  return content
    .filter((part) => part.type === 'text' && part.text)
    .map((part) => part.text!)
    .join('\n')
}

export function rawAnchorMessages(messages: RawJsonlMessage[]): ResumeAnchorMessage[] {
  const result: ResumeAnchorMessage[] = []
  for (const message of messages) {
    if (message.type === 'user' && isRealUserMessage(message)) {
      result.push({ role: 'user', text: extractRawText(message) })
    } else if (message.type === 'assistant') {
      result.push({ role: 'assistant', text: extractRawText(message) })
    }
  }
  return result
}

export function parsedAnchorMessages(messages: ParsedMessage[]): ResumeAnchorMessage[] {
  const result: ResumeAnchorMessage[] = []
  for (const message of messages) {
    if (message.type === 'user' && !message.isSystemGenerated && isRealUserMessage(message.raw)) {
      result.push({ role: 'user', text: message.textContent })
    } else if (message.type === 'assistant') {
      result.push({ role: 'assistant', text: message.textContent })
    }
  }
  return result
}

/** Normalize a tail anchor so formatting-only differences do not become L3 failures. */
export function normalizeResumeAuditText(text: string): string {
  const normalized = text
    .normalize('NFKC')
    .replace(/```[^\n]*\n?/g, '')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(?:#{1,6}|>|[-+*]|\d+[.)])\s+/gm, '')
    .replace(/<[^>]+>/g, '')
    .replace(/[\s*_~]+/g, '')
    .trim()
  return Array.from(normalized).slice(0, 200).join('')
}

export function anchorsFromMessages(messages: ResumeAnchorMessage[]): ResumeAnchors {
  let user = ''
  let assistant = ''
  for (const message of messages) {
    const text = normalizeResumeAuditText(message.text)
    if (!text) continue
    if (message.role === 'user') user = text
    else assistant = text
  }
  return { user, assistant }
}

function targetContainsAnchors(messages: ResumeAnchorMessage[], expected: ResumeAnchors): boolean {
  const normalized = messages.map((message) => ({
    role: message.role,
    text: normalizeResumeAuditText(message.text)
  }))
  const expectedValues: Array<['user' | 'assistant', string]> = [
    ['user', expected.user],
    ['assistant', expected.assistant]
  ]
  const present = expectedValues.filter(([, value]) => !!value)
  return present.length > 0 && present.every(([role, value]) =>
    normalized.some((message) => message.role === role && message.text === value)
  )
}

/** Shared L3 decision used by both resume-audit and the recovery verifier. */
export function classifyResumeL3(
  expected: ResumeAnchors,
  target: ResumeL3TargetData
): ResumeL3Decision {
  const actualAnchors = anchorsFromMessages(target.defaultMessages)
  if (target.status === 'missing' || target.status === 'unparseable') {
    return { status: 'would-404', actualAnchors }
  }
  if (!expected.user && !expected.assistant) {
    return { status: 'skipped', reason: 'expected-anchor-empty', actualAnchors }
  }
  if (expected.user === actualAnchors.user && expected.assistant === actualAnchors.assistant) {
    return { status: 'match', actualAnchors }
  }

  const mismatchKind: ResumeL3MismatchKind =
    target.status === 'empty' || (!actualAnchors.user && !actualAnchors.assistant)
      ? 'empty'
      : targetContainsAnchors(target.allMessages, expected)
        ? 'wrong-branch'
        : 'stale'
  return { status: 'mismatch', mismatchKind, actualAnchors }
}

function sha256(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex')
}

function integrityEvidence(source: Buffer, target: Buffer): ResumeIntegrityEvidence {
  const sourceHash = sha256(source)
  const targetHash = sha256(target)
  const byteEqual = source.equals(target)
  const hashEqual = sourceHash === targetHash
  return {
    algorithm: 'sha256',
    sourceHash,
    targetHash,
    sourceBytes: source.length,
    targetBytes: target.length,
    byteEqual,
    hashEqual,
    matches: byteEqual && hashEqual
  }
}

function rawRows(validation: BackupValidationResult): RawJsonlMessage[] {
  return validation.parsedLines.map((line) => line.value as unknown as RawJsonlMessage)
}

/**
 * Pure recovery verifier: strict JSONL on both byte sequences, shared L3 anchor
 * selection, then exact-byte and full SHA-256 equality. It performs no I/O.
 */
export function verifyClaudeResumeTarget(
  sourceInput: Buffer | string,
  targetInput: Buffer | string,
  options: BackupValidationOptions = {}
): ClaudeResumeVerificationResult {
  const source = Buffer.isBuffer(sourceInput) ? Buffer.from(sourceInput) : Buffer.from(sourceInput, 'utf8')
  const target = Buffer.isBuffer(targetInput) ? Buffer.from(targetInput) : Buffer.from(targetInput, 'utf8')
  const sourceValidation = validateBackupJsonl(source, options)
  const targetValidation = validateBackupJsonl(target, options)
  const integrity = integrityEvidence(source, target)

  const sourceRows = rawRows(sourceValidation)
  const targetRows = rawRows(targetValidation)
  const expected = anchorsFromMessages(rawAnchorMessages(selectClaudeDefaultChain(sourceRows)))
  const allTargetMessages = rawAnchorMessages(targetRows)
  const defaultTargetMessages = rawAnchorMessages(selectClaudeDefaultChain(targetRows))
  const l3 = classifyResumeL3(expected, {
    status: allTargetMessages.length > 0 ? 'found' : 'empty',
    defaultMessages: defaultTargetMessages,
    allMessages: allTargetMessages
  })

  const status: ClaudeResumeVerificationResult['status'] = !sourceValidation.ok
    ? 'invalid-source'
    : !targetValidation.ok
      ? 'invalid-target'
      : l3.status === 'match' && integrity.matches
        ? 'match'
        : 'mismatch'
  return { status, l3, integrity, sourceValidation, targetValidation }
}
