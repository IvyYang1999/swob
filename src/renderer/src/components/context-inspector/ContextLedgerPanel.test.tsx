/**
 * @vitest-environment jsdom
 */
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { ContextLedgerPanel, type ContextLedgerLabels } from './ContextLedgerPanel'

const labels: ContextLedgerLabels = {
  title: 'Context evidence', unknown: 'Unknown', currentSnapshot: 'Current snapshot',
  reportedInput: 'Reported input', estimatedTokens: 'Estimated tokens', introduced: 'Introduced',
  preserved: 'Preserved', summarized: 'Summarized', dropped: 'Dropped', mcpExposure: 'MCP evidence',
  configured: 'Configured', instructions: 'Instructions', toolName: 'Tool name', schema: 'Schema',
  called: 'Called', result: 'Result', source: 'Source', time: 'Time', transition: 'Transition',
  trigger: 'Trigger', operation: 'Operation', visibleToModel: 'Visible to model', evidence: 'Evidence'
}

afterEach(cleanup)

describe('ContextLedgerPanel', () => {
  it('reveals persisted source, time, injection hierarchy and transition details', () => {
    render(<ContextLedgerPanel labels={labels} projection={{
      artifacts: [{
        contextArtifactId: 'artifact-1', kind: 'instruction-file',
        sourceUri: { status: 'available', value: 'project://AGENTS.md' },
        capturedAt: '2026-08-11T00:00:00.000Z',
        effectiveAt: { status: 'available', value: '2026-08-11T00:00:01.000Z' },
        evidence: [{ grade: 'B', sourceKind: 'transcript' }]
      }],
      injections: [{
        contextInjectionId: 'injection-1', contextArtifactId: 'artifact-1', operation: 'add',
        trigger: 'session-start', visibleToModel: true
      }],
      snapshots: [{ reportedInputTokens: { status: 'available', value: 42 }, unknownInputTokens: { status: 'available', value: 42 } }],
      transitions: [{
        contextTransitionId: 'transition-1', kind: 'compact',
        effectiveAt: { status: 'available', value: '2026-08-11T00:00:02.000Z' },
        deltas: [{ contextArtifactId: 'artifact-1', disposition: 'summarized' }]
      }],
      mcpExposures: [], evidenceCounts: { A: 0, B: 1, C: 0, D: 0, E: 0 }, unknownArtifactCount: 1
    }} />)

    fireEvent.click(screen.getByRole('button', { name: /Context evidence/ }))
    expect(screen.getByText(/Source: project:\/\/AGENTS\.md/)).toBeInTheDocument()
    expect(screen.getByText(/Time: 2026-08-11T00:00:01\.000Z/)).toBeInTheDocument()
    expect(screen.getByTestId('context-ledger-injection')).toHaveTextContent('session-start')
    expect(screen.getByTestId('context-ledger-transition')).toHaveTextContent('Transition: compact')
    expect(screen.getByTestId('context-ledger-transition')).toHaveTextContent('summarized')
  })
})
