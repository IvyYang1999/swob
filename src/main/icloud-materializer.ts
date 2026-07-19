import { execFile as nodeExecFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { access, readFile } from 'node:fs/promises'
import * as path from 'node:path'
import { validateBackupJsonl, type BackupValidationOptions, type BackupValidationResult } from './backup-validator'

export interface ICloudBackupPaths {
  targetPath: string
  placeholderPath: string
  inputWasPlaceholder: boolean
}

export interface ICloudMaterializerRuntime {
  pathExists(filePath: string): Promise<boolean>
  readFile(filePath: string): Promise<Buffer>
  execFile(executable: string, args: string[]): Promise<void>
  delay(milliseconds: number): Promise<void>
}

export interface ICloudMaterializerOptions {
  maxPollAttempts?: number
  initialPollDelayMs?: number
  maxPollDelayMs?: number
  validation?: BackupValidationOptions
  expected?: ICloudExpectedMetadata
  allowUnverified?: boolean
  runtime?: ICloudMaterializerRuntime
}

export interface ICloudExpectedMetadata {
  sha256?: string
  size?: number
}

interface ICloudMaterializeSuccessBase {
  ok: true
  targetPath: string
  placeholderPath: string
  content: Buffer
  validation: BackupValidationResult
  pollAttempts: number
}

export interface ICloudVerifiedMaterializeSuccess extends ICloudMaterializeSuccessBase {
  state: 'already-materialized' | 'materialized'
  confidence: 'expected-metadata'
}

interface ICloudUnverifiedMaterializeBase {
  ok: false
  state: 'unverified'
  confidence: 'prefix-unverifiable'
  targetPath: string
  placeholderPath: string
  validation: BackupValidationResult
  pollAttempts: number
}

export type ICloudUnverifiedMaterializeResult = ICloudUnverifiedMaterializeBase & {
  content?: never
}

export type ICloudAllowedUnverifiedMaterializeResult = ICloudUnverifiedMaterializeBase & {
  content: Buffer
}

export type ICloudMaterializeSuccess = ICloudVerifiedMaterializeSuccess

export interface ICloudMaterializeFailure {
  ok: false
  reason: 'not-found' | 'brctl-failed' | 'timeout'
  targetPath: string
  placeholderPath: string
  diagnostic: string
  pollAttempts: number
  lastValidation?: BackupValidationResult
}

export type ICloudMaterializeDefaultResult =
  | ICloudMaterializeSuccess
  | ICloudUnverifiedMaterializeResult
  | ICloudMaterializeFailure

export type ICloudMaterializeAllowedResult =
  | ICloudMaterializeSuccess
  | ICloudAllowedUnverifiedMaterializeResult
  | ICloudMaterializeFailure

export type ICloudMaterializeResult =
  | ICloudMaterializeDefaultResult
  | ICloudMaterializeAllowedResult

interface CompletionInspection {
  complete: boolean
  placeholderExists: boolean
  targetExists: boolean
  content?: Buffer
  validation?: BackupValidationResult
  expectedMatches?: boolean
}

const BRCTL_PATH = '/usr/bin/brctl'

function defaultPathExists(filePath: string): Promise<boolean> {
  return access(filePath).then(() => true, () => false)
}

function defaultExecFile(executable: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    nodeExecFile(executable, args, { timeout: 10_000 }, (error) => {
      if (error) reject(error)
      else resolve()
    })
  })
}

const DEFAULT_RUNTIME: ICloudMaterializerRuntime = {
  pathExists: defaultPathExists,
  readFile,
  execFile: defaultExecFile,
  delay: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))
}

/** Resolve either backup.jsonl or .backup.jsonl.icloud to the same exact pair. */
export function resolveICloudBackupPaths(inputPath: string): ICloudBackupPaths {
  const baseName = path.basename(inputPath)
  const placeholderMatch = baseName.match(/^\.(.+)\.icloud$/)
  if (placeholderMatch) {
    return {
      targetPath: path.join(path.dirname(inputPath), placeholderMatch[1]),
      placeholderPath: path.normalize(inputPath),
      inputWasPlaceholder: true
    }
  }
  return {
    targetPath: path.normalize(inputPath),
    placeholderPath: path.join(path.dirname(inputPath), `.${baseName}.icloud`),
    inputWasPlaceholder: false
  }
}

async function inspectCompletion(
  paths: ICloudBackupPaths,
  runtime: ICloudMaterializerRuntime,
  validationOptions: BackupValidationOptions,
  expected: ICloudExpectedMetadata | undefined
): Promise<CompletionInspection> {
  const placeholderExists = await runtime.pathExists(paths.placeholderPath)
  const targetExists = await runtime.pathExists(paths.targetPath)
  if (placeholderExists || !targetExists) return { complete: false, placeholderExists, targetExists }

  try {
    const content = await runtime.readFile(paths.targetPath)
    const validation = validateBackupJsonl(content, validationOptions)
    const expectedMatches = expected === undefined
      ? undefined
      : (expected.sha256 === undefined ||
          createHash('sha256').update(content).digest('hex') === expected.sha256.toLowerCase()) &&
        (expected.size === undefined || content.length === expected.size)
    return {
      complete: validation.ok && expectedMatches !== false,
      placeholderExists,
      targetExists,
      content,
      validation,
      expectedMatches
    }
  } catch {
    return { complete: false, placeholderExists, targetExists }
  }
}

function normalizedExpected(expected: ICloudExpectedMetadata | undefined): ICloudExpectedMetadata | undefined {
  if (!expected || (expected.sha256 === undefined && expected.size === undefined)) return undefined
  if (expected.sha256 !== undefined && !/^[0-9a-f]{64}$/i.test(expected.sha256)) {
    throw new Error('expected.sha256 must be a 64-character hexadecimal SHA-256')
  }
  if (expected.size !== undefined && (!Number.isSafeInteger(expected.size) || expected.size < 0)) {
    throw new Error('expected.size must be a non-negative safe integer')
  }
  return {
    sha256: expected.sha256?.toLowerCase(),
    size: expected.size
  }
}

function completionResult(
  paths: ICloudBackupPaths,
  inspection: CompletionInspection,
  verifiedState: ICloudVerifiedMaterializeSuccess['state'],
  pollAttempts: number,
  expected: ICloudExpectedMetadata | undefined,
  allowUnverified: boolean
): ICloudMaterializeSuccess | ICloudUnverifiedMaterializeResult | ICloudAllowedUnverifiedMaterializeResult {
  const evidence = {
    targetPath: paths.targetPath,
    placeholderPath: paths.placeholderPath,
    validation: inspection.validation!,
    pollAttempts
  }
  if (!expected) {
    const unverified = {
      ...evidence,
      ok: false as const,
      state: 'unverified' as const,
      confidence: 'prefix-unverifiable' as const
    }
    return allowUnverified
      ? { ...unverified, content: inspection.content! }
      : unverified
  }
  return {
    ...evidence,
    ok: true,
    state: verifiedState,
    confidence: 'expected-metadata',
    content: inspection.content!
  }
}

/**
 * Trigger and await iCloud materialization. Strong completion additionally
 * requires the locally read bytes to match caller-supplied expected metadata.
 * Without expected metadata, a valid local EOF is explicitly reported as an
 * unverifiable non-success because it cannot prove the remote object's final
 * EOF. Its content is exposed only when allowUnverified is explicitly true.
 */
export function materializeICloudBackup(
  inputPath: string,
  options: ICloudMaterializerOptions & { allowUnverified: true }
): Promise<ICloudMaterializeAllowedResult>
export function materializeICloudBackup(
  inputPath: string,
  options?: ICloudMaterializerOptions & { allowUnverified?: false }
): Promise<ICloudMaterializeDefaultResult>
export function materializeICloudBackup(
  inputPath: string,
  options?: ICloudMaterializerOptions
): Promise<ICloudMaterializeResult>
export async function materializeICloudBackup(
  inputPath: string,
  options: ICloudMaterializerOptions = {}
): Promise<ICloudMaterializeResult> {
  const paths = resolveICloudBackupPaths(inputPath)
  const runtime = options.runtime || DEFAULT_RUNTIME
  const validationOptions = options.validation || {}
  const expected = normalizedExpected(options.expected)
  const maxPollAttempts = options.maxPollAttempts ?? 34
  const initialPollDelayMs = options.initialPollDelayMs ?? 200
  const maxPollDelayMs = options.maxPollDelayMs ?? 1_000
  if (!Number.isInteger(maxPollAttempts) || maxPollAttempts < 1) {
    throw new Error('maxPollAttempts must be a positive integer')
  }
  if (initialPollDelayMs < 0 || maxPollDelayMs < initialPollDelayMs) {
    throw new Error('poll delay bounds are invalid')
  }

  const initial = await inspectCompletion(paths, runtime, validationOptions, expected)
  if (initial.complete) {
    return completionResult(
      paths,
      initial,
      'already-materialized',
      0,
      expected,
      options.allowUnverified === true
    )
  }
  if (!initial.placeholderExists && !initial.targetExists) {
    return {
      ok: false,
      reason: 'not-found',
      targetPath: paths.targetPath,
      placeholderPath: paths.placeholderPath,
      diagnostic: 'neither the backup nor its same-directory iCloud placeholder exists',
      pollAttempts: 0
    }
  }

  const downloadPath = initial.placeholderExists ? paths.placeholderPath : paths.targetPath
  try {
    await runtime.execFile(BRCTL_PATH, ['download', downloadPath])
  } catch {
    return {
      ok: false,
      reason: 'brctl-failed',
      targetPath: paths.targetPath,
      placeholderPath: paths.placeholderPath,
      diagnostic: 'brctl could not start the iCloud download; retry when the environment permits it',
      pollAttempts: 0,
      lastValidation: initial.validation
    }
  }

  let delayMs = initialPollDelayMs
  let last = initial
  for (let attempt = 1; attempt <= maxPollAttempts; attempt++) {
    last = await inspectCompletion(paths, runtime, validationOptions, expected)
    if (last.complete) {
      return completionResult(
        paths,
        last,
        'materialized',
        attempt,
        expected,
        options.allowUnverified === true
      )
    }
    if (attempt < maxPollAttempts) {
      await runtime.delay(delayMs)
      delayMs = Math.min(maxPollDelayMs, Math.max(delayMs * 2, 1))
    }
  }

  return {
    ok: false,
    reason: 'timeout',
    targetPath: paths.targetPath,
    placeholderPath: paths.placeholderPath,
    diagnostic: last.placeholderExists
      ? 'iCloud placeholder did not disappear before the polling limit'
      : last.expectedMatches === false
        ? 'materialized bytes did not match expected backup SHA-256/size before the polling limit'
        : 'materialized file never became fully readable strict JSONL before the polling limit',
    pollAttempts: maxPollAttempts,
    lastValidation: last.validation
  }
}
