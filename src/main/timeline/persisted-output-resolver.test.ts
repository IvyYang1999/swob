import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { PersistedOutputRef } from '../../shared/contracts/truth-kernel'
import {
  exportPersistedOutputReference,
  pathWithinAllowedRoot,
  resolvePersistedOutput
} from './persisted-output-resolver'

const temporaryRoots: string[] = []

afterEach(async () => {
  const { rm } = await import('node:fs/promises')
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function reference(bytes: Uint8Array, mimeType = 'application/json', outputKind: PersistedOutputRef['outputKind'] = 'structured-media'): PersistedOutputRef {
  return {
    artifactId: 'artifact-1',
    sourceLocator: { kind: 'artifact', locatorHash: 'opaque-locator' },
    digest: { status: 'available', value: createHash('sha256').update(bytes).digest('hex') },
    sizeBytes: { status: 'available', value: bytes.byteLength },
    mimeType: { status: 'available', value: mimeType },
    provenance: [],
    allowedRoots: [{ rootId: 'library', access: 'read', granted: true }],
    contentState: 'available',
    outputKind,
    activeContentAllowed: false
  }
}

async function fixture(filename: string, bytes: Uint8Array): Promise<{ root: string; file: string }> {
  const root = await mkdtemp(path.join(tmpdir(), 'swob-t211b-output-'))
  temporaryRoots.push(root)
  const file = path.join(root, filename)
  await writeFile(file, bytes)
  return { root, file }
}

describe('PersistedOutput trusted resolver', () => {
  it('resolves a hash/size/MIME-matched passive structured document and preserves export references', async () => {
    const bytes = Buffer.from('{"ok":true}')
    const { root, file } = await fixture('result.json', bytes)
    const artifact = reference(bytes)
    const result = await resolvePersistedOutput({ reference: artifact, candidatePath: file, allowedRoots: [{ rootId: 'library', absolutePath: root }] })
    expect(result).toMatchObject({ status: 'available', preview: 'passive-text', activeContentAllowed: false, mimeType: 'application/json' })
    expect(exportPersistedOutputReference(artifact)).toEqual(artifact)
  })

  it('accepts passive PDF/document fixtures but never enables active content', async () => {
    const pdf = Buffer.from('%PDF-1.7\nfixture')
    const pdfFixture = await fixture('report.pdf', pdf)
    expect(await resolvePersistedOutput({ reference: reference(pdf, 'application/pdf', 'pdf'), candidatePath: pdfFixture.file, allowedRoots: [{ rootId: 'library', absolutePath: pdfFixture.root }] }))
      .toMatchObject({ status: 'available', preview: 'download-only', activeContentAllowed: false })
    const document = Buffer.from('# Report\n')
    const documentFixture = await fixture('report.md', document)
    expect(await resolvePersistedOutput({ reference: reference(document, 'text/markdown', 'document'), candidatePath: documentFixture.file, allowedRoots: [{ rootId: 'library', absolutePath: documentFixture.root }] }))
      .toMatchObject({ status: 'available', preview: 'passive-text', activeContentAllowed: false })
  })

  it.each([
    ['missing', 'missing'] as const,
    ['hash mismatch', 'hash-mismatch'] as const,
    ['MIME mismatch', 'mime-mismatch'] as const,
    ['large file', 'size-limit'] as const
  ])('rejects %s without discarding the reference', async (scenario, reason) => {
    const bytes = Buffer.from('{"ok":true}')
    const { root, file } = await fixture('result.json', bytes)
    const artifact = reference(bytes)
    const candidatePath = scenario === 'missing' ? path.join(root, 'missing.json') : file
    if (scenario === 'hash mismatch') artifact.digest = { status: 'available', value: '0'.repeat(64) }
    if (scenario === 'MIME mismatch') artifact.mimeType = { status: 'available', value: 'text/plain' }
    const result = await resolvePersistedOutput({ reference: artifact, candidatePath, allowedRoots: [{ rootId: 'library', absolutePath: root }], maxBytes: scenario === 'large file' ? 2 : undefined })
    expect(result).toMatchObject({ status: 'rejected', reason, reference: artifact })
  })

  it('rejects path traversal, ungranted custom roots and symlink traversal', async () => {
    const outside = await fixture('outside.json', Buffer.from('{}'))
    const inside = await fixture('inside.json', Buffer.from('{}'))
    const artifact = reference(Buffer.from('{}'))
    expect(await resolvePersistedOutput({ reference: artifact, candidatePath: outside.file, allowedRoots: [{ rootId: 'library', absolutePath: inside.root }] }))
      .toMatchObject({ status: 'rejected', reason: 'outside-allowed-root' })
    artifact.allowedRoots[0].granted = false
    expect(await resolvePersistedOutput({ reference: artifact, candidatePath: inside.file, allowedRoots: [{ rootId: 'library', absolutePath: inside.root }] }))
      .toMatchObject({ status: 'rejected', reason: 'outside-allowed-root' })
    artifact.allowedRoots[0].granted = true
    const links = path.join(inside.root, 'links')
    await mkdir(links)
    const link = path.join(links, 'result.json')
    await symlink(outside.file, link)
    expect(await resolvePersistedOutput({ reference: artifact, candidatePath: link, allowedRoots: [{ rootId: 'library', absolutePath: inside.root }] }))
      .toMatchObject({ status: 'rejected', reason: 'outside-allowed-root' })
    const internalLink = path.join(inside.root, 'internal-link.json')
    await symlink(inside.file, internalLink)
    expect(await resolvePersistedOutput({ reference: artifact, candidatePath: internalLink, allowedRoots: [{ rootId: 'library', absolutePath: inside.root }] }))
      .toMatchObject({ status: 'rejected', reason: 'symlink-rejected' })
  })

  it('covers Windows HOME, WSL and custom-root containment without host-dependent path parsing', () => {
    expect(pathWithinAllowedRoot('C:\\Users\\alice\\.codex\\sessions\\a.jsonl', 'C:\\Users\\alice\\.codex', 'win32')).toBe(true)
    expect(pathWithinAllowedRoot('D:\\custom\\sessions\\a.jsonl', 'D:\\custom', 'win32')).toBe(true)
    expect(pathWithinAllowedRoot('C:\\Users\\alice\\outside.jsonl', 'D:\\custom', 'win32')).toBe(false)
    expect(pathWithinAllowedRoot('/home/alice/.codex/sessions/a.jsonl', '/home/alice/.codex', 'posix')).toBe(true)
  })
})
