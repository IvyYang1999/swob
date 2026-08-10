/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ExternalEvidenceAttachment } from '../../../../shared/contracts/truth-kernel'
import { SessionEvidencePanel } from './SessionEvidencePanel'

const attachment: ExternalEvidenceAttachment = {
  schemaVersion: 1, logicalAttachmentId: 'private-logical-id', revisionId: 'private-revision-id', revision: 1,
  supersedesRevisionId: { status: 'unknown', reason: 'initial' }, externalProviderId: 'claude-tap', sourceDigest: 'a'.repeat(64), sourceIngestReceiptId: 'private-receipt-id', schemaId: 'claude-tap.capture', sourceVersion: '1',
  mappedLogicalSessionId: { status: 'available', value: 'private-session-id' }, matchMethod: 'user-selected', confirmation: 'unconfirmed', state: 'active', reason: { status: 'unknown', reason: 'none' }, privacyState: 'private-local', contentRetention: 'reference-only', sourceDeletionAuthorized: false, attachedAt: '2026-08-11T00:00:00.000Z', evidence: [],
  assurance: [{ dimension: 'network', assessment: 'unknown', evidenceRefs: [], verificationResultIds: [], canProve: [], cannotProve: ['causality'] }]
}

afterEach(cleanup)
describe('SessionEvidencePanel', () => {
  it('shows privacy-safe provenance and invokes manual confirmation', () => {
    const onConfirm = vi.fn()
    const { container } = render(<SessionEvidencePanel attachment={attachment} locale="en" onConfirm={onConfirm} />)
    expect(screen.getByText('claude-tap')).toBeTruthy()
    expect(screen.getByText('private-local')).toBeTruthy()
    expect(container.textContent).not.toContain('private-session-id')
    expect(container.textContent).not.toContain('private-receipt-id')
    fireEvent.click(screen.getByRole('button', { name: 'Confirm attachment to this session' }))
    expect(onConfirm).toHaveBeenCalledOnce()
  })
})
