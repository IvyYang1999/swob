/** @vitest-environment jsdom */
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { ProviderManifest } from '../../../../shared/provider-schema-v2.generated'
import { ProductionProviderDoctor, ProviderDoctor } from './ProviderDoctor'
import { T211B_LOCALE_BUNDLE } from '../timeline/translations'

const manifest: ProviderManifest = {
  schemaVersion: 2, providerId: 'swob/test', displayName: 'Test Harness', implementationVersion: '1', parserDataVersion: 'fixture', formatVersions: ['fixture'], resumeContract: null,
  capabilities: {
    discover: { status: 'available', reason: null, evidence: [] },
    transcript: { status: 'unavailable', reason: 'no sample', evidence: [] }
  }
}

afterEach(cleanup)

describe('ProviderDoctor', () => {
  it('derives capability rows from the manifest, including unavailable reasons', () => {
    render(<ProviderDoctor providers={[{ manifest, sourceLabel: 'fixture', discovery: 'found', discoveryReason: null, lastSuccessfulParseAt: null, unknownEvents: 2, partialEvents: 1, executionDomain: 'wsl' }]} />)
    const heading = screen.getByRole('heading', { name: T211B_LOCALE_BUNDLE.en['doctor.label'] })
    expect(heading.className).toContain('text-primary')
    expect(heading.className).not.toContain('text-base')
    expect(screen.getByText('discover')).toBeTruthy()
    expect(screen.getByText('transcript')).toBeTruthy()
    expect(screen.getByText(/no sample/)).toBeTruthy()
    expect(screen.getByText(/Unknown: 2/)).toBeTruthy()
  })

  it('renders status labels from the zh locale bundle', () => {
    render(<ProviderDoctor locale="zh" providers={[{ manifest, sourceLabel: 'fixture', discovery: 'found', discoveryReason: null, lastSuccessfulParseAt: null, unknownEvents: 2, partialEvents: 1, executionDomain: 'wsl' }]} />)
    expect(screen.getByText(T211B_LOCALE_BUNDLE.zh['doctor.label'])).toBeTruthy()
    expect(screen.getByText(T211B_LOCALE_BUNDLE.zh['doctor.capability.exact'])).toBeTruthy()
    const unavailable = document.querySelector('[data-capability-status="unavailable"]')
    expect(unavailable?.textContent).toContain(T211B_LOCALE_BUNDLE.zh['doctor.unavailable'])
  })

  it('renders every production Registry source through the feature-local parity view', () => {
    render(<ProductionProviderDoctor />)
    expect(screen.getByText('Claude Code')).toBeTruthy()
    expect(screen.getByText('Gemini CLI')).toBeTruthy()
    expect(document.querySelectorAll('[data-provider-id]')).toHaveLength(14)
    expect(document.querySelectorAll('[data-capability-status]')).toHaveLength(14 * 16)
    expect(document.body.textContent).not.toContain('/Users/')
  })
})
