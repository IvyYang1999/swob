import { expect, test } from '@playwright/test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import react from '@vitejs/plugin-react'
import { createServer } from 'vite'
import type { ExternalEvidenceAttachment, VerificationResult } from '../src/shared/contracts/truth-kernel'
import { translateSessionEvidence } from '../src/shared/translation-contributions/session-evidence'

const attachment: ExternalEvidenceAttachment = {
  schemaVersion: 1, logicalAttachmentId: 'attachment-private-not-rendered', revisionId: 'revision-private-not-rendered', revision: 1,
  supersedesRevisionId: { status: 'unknown', reason: 'initial' }, externalProviderId: 'claude-tap', sourceDigest: 'a'.repeat(64), sourceIngestReceiptId: 'receipt-private-not-rendered',
  schemaId: 'claude-tap.capture', sourceVersion: '1', mappedLogicalSessionId: { status: 'available', value: 'session-private-not-rendered' }, matchMethod: 'user-selected', confirmation: 'unconfirmed', state: 'active', reason: { status: 'unknown', reason: 'none' },
  privacyState: 'private-local', contentRetention: 'reference-only', sourceDeletionAuthorized: false, attachedAt: '2026-08-11T00:00:00.000Z', evidence: [],
  assurance: ['attachment-identity', 'runtime-platform', 'profile-policy', 'network', 'event-source-integrity', 'attestation-external-commitment', 'filesystem-outcome', 'rollback', 'completeness'].map((dimension, index) => ({ dimension: dimension as ExternalEvidenceAttachment['assurance'][number]['dimension'], assessment: index % 4 === 0 ? 'observed' : index % 4 === 1 ? 'verified' : index % 4 === 2 ? 'claimed' : 'unknown', evidenceRefs: [], verificationResultIds: [], canProve: [], cannotProve: ['causality'] }))
}
const verification: VerificationResult = { schemaVersion: 1, verificationId: 'verify-1', target: { kind: 'artifact', id: 'revision-private-not-rendered' }, checkedAt: '2026-08-11T00:00:00.000Z', verifierId: 'offline', verifierKind: 'built-in-offline', verifierVersion: '1', status: 'invalid', failures: [{ code: 'event-digest-mismatch', artifactPath: { status: 'available', value: 'redacted' }, message: 'digest mismatch', expectedDigest: { status: 'unknown', reason: 'redacted' }, actualDigest: { status: 'unknown', reason: 'redacted' } }] }

const style = `<style>*{box-sizing:border-box}body{margin:0;padding:12px;background:#f7f7f8;color:#25262b;font:14px -apple-system,BlinkMacSystemFont,sans-serif}section{width:100%;max-width:760px;max-height:250px;overflow:auto;border:1px solid #d8d8df;border-radius:12px;background:#fff;padding:16px}h3{margin:0 0 12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}dl{margin:0}dl>div{display:flex;gap:12px;align-items:center;padding:8px 0;border-top:1px solid #eee}dt{min-width:0;flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}dd{flex:none;margin:0;border-radius:999px;padding:3px 8px;background:#f3ede0;color:#66470e}[data-verification=invalid]{background:#f8e5e3;color:#842a25;padding:8px;border-radius:6px}button{margin-top:12px;border:1px solid #7550a8;background:#fff;border-radius:8px;padding:8px 12px;color:#613c95}button:hover,button:focus-visible{outline:3px solid #b99be5;outline-offset:2px}</style>`

test('shipped React SessionEvidencePanel remains usable at narrow and wide widths', async ({ page }, testInfo) => {
  const vite = await createServer({ configFile: false, server: { middlewareMode: true }, appType: 'custom', plugins: [react()] })
  try {
    const loaded = await vite.ssrLoadModule('/src/renderer/src/components/session-evidence/SessionEvidencePanel.tsx') as typeof import('../src/renderer/src/components/session-evidence/SessionEvidencePanel')
    for (const scenario of [{ locale: 'en' as const, width: 820, height: 480 }, { locale: 'zh' as const, width: 360, height: 640 }]) {
    const markup = renderToStaticMarkup(createElement(loaded.SessionEvidencePanel, { attachment, verification, locale: scenario.locale }))
    await page.setViewportSize({ width: scenario.width, height: scenario.height })
    await page.setContent(`<!doctype html>${style}${markup}`)
    const panel = page.getByRole('region', { name: translateSessionEvidence(scenario.locale, 'sessionEvidence.title') })
    await expect(panel).toBeVisible()
    for (const assessment of ['observed', 'verified', 'claimed', 'unknown'] as const) await expect(page.getByText(translateSessionEvidence(scenario.locale, `sessionEvidence.assessment.${assessment}`)).first()).toBeVisible()
    await expect(page.locator('[data-verification="invalid"]')).toBeVisible()
    const confirm = page.getByRole('button', { name: translateSessionEvidence(scenario.locale, 'sessionEvidence.manualConfirm') })
    await confirm.hover(); await confirm.focus(); await expect(confirm).toBeFocused()
    const panelBox = await panel.boundingBox(); const buttonBox = await confirm.boundingBox()
    expect(panelBox && buttonBox && buttonBox.x + buttonBox.width <= panelBox.x + panelBox.width).toBeTruthy()
    await panel.evaluate((element) => { element.scrollTop = 0 })
    await panel.screenshot({ path: testInfo.outputPath(`session-evidence-react-${scenario.locale}-${scenario.width}-top.png`) })
    await panel.evaluate((element) => { element.scrollTop = element.scrollHeight })
    expect(await panel.evaluate((element) => element.scrollTop > 0)).toBeTruthy()
    await expect(page.getByText('session-private-not-rendered')).toHaveCount(0)
    await panel.screenshot({ path: testInfo.outputPath(`session-evidence-react-${scenario.locale}-${scenario.width}-bottom.png`) })
    }
  } finally {
    await vite.close()
  }
})
