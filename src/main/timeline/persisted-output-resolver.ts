import { createHash } from 'node:crypto'
import { lstat, readFile, realpath, stat } from 'node:fs/promises'
import * as path from 'node:path'
import type { PersistedOutputRef } from '../../shared/contracts/truth-kernel'

export const DEFAULT_PERSISTED_OUTPUT_MAX_BYTES = 8 * 1024 * 1024

export type PersistedOutputRejection =
  | 'missing'
  | 'outside-allowed-root'
  | 'symlink-rejected'
  | 'not-a-file'
  | 'size-limit'
  | 'size-mismatch'
  | 'mime-mismatch'
  | 'hash-mismatch'
  | 'metadata-unavailable'

export interface PersistedOutputAllowedRoot {
  rootId: string
  absolutePath: string
}

export type PersistedOutputResolution =
  | {
      status: 'available'
      absolutePath: string
      bytes: Uint8Array
      sizeBytes: number
      mimeType: string
      sha256: string
      preview: 'passive-image' | 'passive-text' | 'download-only'
      activeContentAllowed: false
    }
  | {
      status: 'rejected'
      reason: PersistedOutputRejection
      detail: string
      reference: PersistedOutputRef
    }

export interface ResolvePersistedOutputInput {
  reference: PersistedOutputRef
  /** Resolved by the caller's opaque locator table; the locator itself never carries a private path. */
  candidatePath: string
  allowedRoots: readonly PersistedOutputAllowedRoot[]
  maxBytes?: number
}

function reject(reference: PersistedOutputRef, reason: PersistedOutputRejection, detail: string): PersistedOutputResolution {
  return { status: 'rejected', reason, detail, reference }
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

async function containsSymlink(root: string, candidate: string): Promise<boolean> {
  const relative = path.relative(root, candidate)
  let cursor = root
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment)
    if ((await lstat(cursor)).isSymbolicLink()) return true
  }
  return false
}

function sniffMime(bytes: Uint8Array, filename: string): string {
  if (bytes.length >= 5 && Buffer.from(bytes.subarray(0, 5)).toString('ascii') === '%PDF-') return 'application/pdf'
  if (bytes.length >= 8 && Buffer.from(bytes.subarray(0, 8)).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png'
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes.length >= 6 && ['GIF87a', 'GIF89a'].includes(Buffer.from(bytes.subarray(0, 6)).toString('ascii'))) return 'image/gif'
  if (bytes.length >= 12 && Buffer.from(bytes.subarray(0, 4)).toString('ascii') === 'RIFF' && Buffer.from(bytes.subarray(8, 12)).toString('ascii') === 'WEBP') return 'image/webp'
  const extension = path.extname(filename).toLowerCase()
  if (extension === '.json') return 'application/json'
  if (extension === '.md' || extension === '.markdown') return 'text/markdown'
  if (extension === '.txt' || extension === '.log' || extension === '.csv') return extension === '.csv' ? 'text/csv' : 'text/plain'
  return 'application/octet-stream'
}

function mimeAllowed(reference: PersistedOutputRef, actual: string): boolean {
  const declared = reference.mimeType.status === 'available' ? reference.mimeType.value.toLowerCase().split(';')[0].trim() : null
  if (!declared || declared !== actual) return false
  switch (reference.outputKind) {
    case 'image': return actual.startsWith('image/') && actual !== 'image/svg+xml'
    case 'pdf': return actual === 'application/pdf'
    case 'document': return actual === 'text/plain' || actual === 'text/markdown' || actual === 'application/pdf'
    case 'structured-media': return actual === 'application/json' || actual === 'text/csv'
    case 'tool-output': return actual === 'application/json' || actual.startsWith('text/')
    case 'unknown': return actual === 'application/octet-stream'
  }
}

function previewFor(reference: PersistedOutputRef, mimeType: string): 'passive-image' | 'passive-text' | 'download-only' {
  if (reference.outputKind === 'image' && mimeType.startsWith('image/')) return 'passive-image'
  if (mimeType.startsWith('text/') || mimeType === 'application/json') return 'passive-text'
  return 'download-only'
}

export function pathWithinAllowedRoot(candidate: string, root: string, platform: 'win32' | 'posix' = process.platform === 'win32' ? 'win32' : 'posix'): boolean {
  const pathApi = platform === 'win32' ? path.win32 : path.posix
  const relative = pathApi.relative(pathApi.resolve(root), pathApi.resolve(candidate))
  return relative === '' || (!relative.startsWith(`..${pathApi.sep}`) && relative !== '..' && !pathApi.isAbsolute(relative))
}

function expectedDigest(reference: PersistedOutputRef): string | null {
  if (reference.digest.status !== 'available') return null
  return reference.digest.value.toLowerCase().replace(/^sha256:/, '')
}

/**
 * Trusted main-process resolver. It re-checks all authority and content facts at
 * read time, rejects every symlink, and never opts active content into preview.
 */
export async function resolvePersistedOutput(input: ResolvePersistedOutputInput): Promise<PersistedOutputResolution> {
  const { reference } = input
  if (!path.isAbsolute(input.candidatePath)) return reject(reference, 'outside-allowed-root', 'The resolved candidate is not absolute.')
  const grantedIds = new Set(reference.allowedRoots.filter((root) => root.granted && root.access === 'read').map((root) => root.rootId))
  const configuredRoots = input.allowedRoots.filter((root) => grantedIds.has(root.rootId))
  if (configuredRoots.length === 0) return reject(reference, 'outside-allowed-root', 'No granted read root matches this reference.')
  if (reference.digest.status !== 'available' || reference.sizeBytes.status !== 'available' || reference.mimeType.status !== 'available') {
    return reject(reference, 'metadata-unavailable', 'Digest, byte size and MIME are required before persisted content can be read.')
  }

  let candidateReal: string
  try {
    candidateReal = await realpath(input.candidatePath)
  } catch {
    return reject(reference, 'missing', 'The persisted output is missing.')
  }

  let acceptedRoot: { configured: string; real: string } | null = null
  for (const root of configuredRoots) {
    const configured = path.resolve(root.absolutePath)
    let real: string
    try {
      real = await realpath(configured)
    } catch {
      continue
    }
    if (isWithin(configured, path.resolve(input.candidatePath)) && isWithin(real, candidateReal)) {
      acceptedRoot = { configured, real }
      break
    }
  }
  if (!acceptedRoot) return reject(reference, 'outside-allowed-root', 'The persisted output resolved outside every granted root.')
  try {
    if (await containsSymlink(acceptedRoot.configured, path.resolve(input.candidatePath))) {
      return reject(reference, 'symlink-rejected', 'Symlinked persisted output paths are not trusted.')
    }
  } catch {
    return reject(reference, 'missing', 'The persisted output changed while it was being resolved.')
  }

  const metadata = await stat(candidateReal)
  if (!metadata.isFile()) return reject(reference, 'not-a-file', 'The persisted output is not a regular file.')
  const maxBytes = input.maxBytes ?? DEFAULT_PERSISTED_OUTPUT_MAX_BYTES
  if (metadata.size > maxBytes) return reject(reference, 'size-limit', `The persisted output exceeds the ${maxBytes}-byte preview limit.`)
  if (metadata.size !== reference.sizeBytes.value) return reject(reference, 'size-mismatch', 'The persisted output byte size changed.')

  const bytes = await readFile(candidateReal)
  const actualMime = sniffMime(bytes, candidateReal)
  if (!mimeAllowed(reference, actualMime)) return reject(reference, 'mime-mismatch', `The content is ${actualMime}, not the declared safe MIME.`)
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  if (sha256 !== expectedDigest(reference)) return reject(reference, 'hash-mismatch', 'The persisted output digest changed.')

  return {
    status: 'available',
    absolutePath: candidateReal,
    bytes,
    sizeBytes: bytes.byteLength,
    mimeType: actualMime,
    sha256,
    preview: previewFor(reference, actualMime),
    activeContentAllowed: false
  }
}

/** Export keeps the immutable reference only; local bytes and private paths never enter a portable transcript. */
export function exportPersistedOutputReference(reference: PersistedOutputRef): PersistedOutputRef {
  return structuredClone(reference)
}
