import {
  detectPhysicalNewlinesInStrings,
  validateBackupJsonl,
  type BackupValidationOptions,
  type BackupValidationResult
} from './backup-validator'

export interface BackupRepairLogEntry {
  action: 'encode-raw-line-break'
  inputByteStart: number
  inputByteEnd: number
  outputByteStart: number
  outputByteEnd: number
  inputForm: 'lf' | 'crlf' | 'cr'
  replacement: '\\n'
}

export type BackupRepairRejectionReason =
  | 'unsupported-damage'
  | 'unsupported-line-ending'
  | 'ambiguous-escaped-boundary'
  | 'candidate-invalid'

export interface BackupRepairSuccess {
  ok: true
  changed: boolean
  content: Buffer
  log: BackupRepairLogEntry[]
  validation: BackupValidationResult
}

export interface BackupRepairRejection {
  ok: false
  reason: BackupRepairRejectionReason
  diagnostic: string
  originalValidation: BackupValidationResult
  candidateValidation?: BackupValidationResult
}

export type BackupRepairResult = BackupRepairSuccess | BackupRepairRejection

/**
 * Repair only raw physical LF/CRLF bytes inside quoted JSON strings. Every
 * other byte is copied in order; no object is reconstructed or stringified.
 */
export function repairBackupJsonl(
  input: Buffer | string,
  options: BackupValidationOptions = {}
): BackupRepairResult {
  const original = Buffer.isBuffer(input) ? Buffer.from(input) : Buffer.from(input, 'utf8')
  const originalValidation = validateBackupJsonl(original, options)
  if (originalValidation.ok) {
    return {
      ok: true,
      changed: false,
      content: Buffer.from(original),
      log: [],
      validation: originalValidation
    }
  }

  const boundaries = detectPhysicalNewlinesInStrings(original)
  if (boundaries.length === 0) {
    return {
      ok: false,
      reason: 'unsupported-damage',
      diagnostic: 'damage is not exclusively a physical line break inside a quoted string',
      originalValidation
    }
  }
  if (boundaries.some((boundary) => boundary.form === 'cr')) {
    return {
      ok: false,
      reason: 'unsupported-line-ending',
      diagnostic: 'raw CR is not an authorized repair form and will not be rewritten as LF',
      originalValidation
    }
  }
  if (boundaries.some((boundary) => boundary.escapedBefore)) {
    return {
      ok: false,
      reason: 'ambiguous-escaped-boundary',
      diagnostic: 'a raw line break follows an unfinished JSON escape, so byte meaning is ambiguous',
      originalValidation
    }
  }

  const chunks: Buffer[] = []
  const log: BackupRepairLogEntry[] = []
  let inputCursor = 0
  let outputCursor = 0
  for (const boundary of boundaries) {
    const unchanged = original.subarray(inputCursor, boundary.byteStart)
    chunks.push(unchanged)
    outputCursor += unchanged.length
    const replacement = Buffer.from('\\n', 'ascii')
    chunks.push(replacement)
    log.push({
      action: 'encode-raw-line-break',
      inputByteStart: boundary.byteStart,
      inputByteEnd: boundary.byteEnd,
      outputByteStart: outputCursor,
      outputByteEnd: outputCursor + replacement.length,
      inputForm: boundary.form,
      replacement: '\\n'
    })
    outputCursor += replacement.length
    inputCursor = boundary.byteEnd
  }
  chunks.push(original.subarray(inputCursor))
  const candidate = Buffer.concat(chunks)
  const candidateValidation = validateBackupJsonl(candidate, options)
  if (!candidateValidation.ok) {
    return {
      ok: false,
      reason: 'candidate-invalid',
      diagnostic: 'the only provenance-preserving candidate still fails strict validation',
      originalValidation,
      candidateValidation
    }
  }

  return {
    ok: true,
    changed: true,
    content: candidate,
    log,
    validation: candidateValidation
  }
}
