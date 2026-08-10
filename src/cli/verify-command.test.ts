import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createEvidenceBundle } from '../main/integrity/evidence-bundle'
import { TRUTH_KERNEL_GOLDEN_FIXTURE, truthKernelCanonicalUtf8Bytes } from '../shared/contracts/truth-kernel'
import { verifyBundleDirectory } from './verify-command'

let fixtureRoot = ''
afterEach(() => { if (fixtureRoot) fs.rmSync(fixtureRoot, { recursive: true, force: true }); fixtureRoot = '' })

describe('swob verify', () => {
  it('verifies a portable bundle and detects changed bytes', () => {
    fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-verify-'))
    const receipt = TRUTH_KERNEL_GOLDEN_FIXTURE.sourceIngestReceipts[0]
    const chain = TRUTH_KERNEL_GOLDEN_FIXTURE.canonicalEventChains[0]
    const events = chain.entries.map((entry) => ({
      eventId: entry.eventId,
      bytes: truthKernelCanonicalUtf8Bytes(TRUTH_KERNEL_GOLDEN_FIXTURE.timelineEvents
        .find((event) => event.sourceEventId === entry.eventId)!.providerEvent)
    }))
    const bundle = createEvidenceBundle({ bundleId: 'cli-fixture', generatedAt: '2026-08-11T00:00:00.000Z', receipts: [receipt], chains: [chain], events })
    for (const [relativePath, bytes] of bundle.files) {
      const output = path.join(fixtureRoot, relativePath)
      fs.mkdirSync(path.dirname(output), { recursive: true })
      fs.writeFileSync(output, bytes)
    }
    expect(verifyBundleDirectory(fixtureRoot, '2026-08-11T01:00:00.000Z').status).toBe('valid')
    fs.appendFileSync(path.join(fixtureRoot, bundle.manifest.artifacts[0].relativePath), 'x')
    expect(verifyBundleDirectory(fixtureRoot, '2026-08-11T01:01:00.000Z').status).toBe('invalid')
  })
})
