import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { collectTruth, renderAll, validateTruth, writeOrCheck } from './generate-docs.mjs'

const repoRoot = path.resolve(import.meta.dirname, '..')
const html = (value) => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;')

describe('Swob docs code synchronization', () => {
  it('keeps every committed generated page synchronized with source truth', () => {
    expect(() => writeOrCheck({ check: true })).not.toThrow()
  })

  it('renders every CLI command and recovery failure message from their registries', () => {
    const truth = collectTruth()
    const outputs = renderAll(truth)
    const cliPage = outputs.get('guides/cli.html')
    const troubleshooting = outputs.get('troubleshooting.html')
    expect(truth.cliCommands.length).toBeGreaterThan(20)
    for (const command of truth.cliCommands) expect(cliPage).toContain(`swob ${html(command.usage)}`)
    for (const [reason, message] of Object.entries(truth.recoveryMessages)) {
      expect(troubleshooting).toContain(reason)
      expect(troubleshooting).toContain(message)
    }
  })

  it('fails when code adds an undocumented accounting bucket', () => {
    const accounting = fs.readFileSync(path.join(repoRoot, 'src/main/token-accounting.ts'), 'utf8')
      .replace('reasoningTokens?: number', 'reasoningTokens?: number\n  futureMetricTokens?: number')
    const truth = collectTruth({ accounting })
    expect(() => validateTruth(truth)).toThrow(/futureMetricTokens/)
  })

  it('fails when Session Audit exports an undocumented metric field', () => {
    const audit = fs.readFileSync(path.join(repoRoot, 'src/main/session-audit.ts'), 'utf8')
      .replace('findings: string[]', 'findings: string[]\n  futureAuditSignal: number')
    const truth = collectTruth({ audit })
    expect(() => validateTruth(truth)).toThrow(/futureAuditSignal/)
  })

  it('fails when the valuation enum adds an undocumented mode', () => {
    const valuation = fs.readFileSync(path.join(repoRoot, 'src/main/token-valuation.ts'), 'utf8')
      .replace("| 'unpriced'", "| 'unpriced' | 'contract-rate'")
    const truth = collectTruth({ valuation })
    expect(() => validateTruth(truth)).toThrow(/contract-rate/)
  })

  it('keeps metric anchors unique and preserves the promised public anchors', () => {
    const manifest = JSON.parse(renderAll().get('generated-manifest.json'))
    expect(new Set(manifest.stableMetricAnchors).size).toBe(manifest.stableMetricAnchors.length)
    expect(manifest.stableMetricAnchors).toEqual(expect.arrayContaining([
      'cache-write', 'cache-write-5m', 'cache-write-1h', 'input-plus-output',
      'billing-total', 'conversation-only', 'api-equivalent-usd', 'valuation-modes',
      'valuation-coverage', 'unavailable', 'unpriced', 'recovery-success-rate'
    ]))
  })

  it('does not emit broken relative links inside the generated documentation', () => {
    const outputs = renderAll()
    const generatedFiles = new Set(outputs.keys())
    generatedFiles.add('assets/docs.css')
    for (const [file, html] of outputs) {
      if (!file.endsWith('.html')) continue
      const links = [...html.matchAll(/(?:href|src)="([^"]+)"/g)].map((match) => match[1])
      for (const link of links) {
        if (/^(?:https?:|#)/.test(link)) continue
        const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), link.split('#')[0]))
        if (target.startsWith('../')) continue
        const candidate = target.endsWith('/') ? `${target}index.html` : target
        expect(generatedFiles, `${file} -> ${link}`).toContain(candidate)
      }
    }
  })
})
