import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { BUILTIN_PROVIDER_DEFINITIONS } from '../src/shared/provider-capabilities'

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

describe('public source matrix generator', () => {
  it('refuses to recreate a website tree inside the desktop repository', () => {
    expect(() => execFileSync(process.execPath, [
      path.resolve('scripts/generate-source-matrix.mjs'),
      path.resolve('website/public/source-matrix.json')
    ], { stdio: 'pipe' })).toThrow()
    expect(fs.existsSync(path.resolve('website/public/source-matrix.json'))).toBe(false)
  })

  it('emits the standalone website contract from the product registry', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-source-matrix-'))
    temporaryDirectories.push(directory)
    const outputFile = path.join(directory, 'source-matrix.json')

    execFileSync(process.execPath, [path.resolve('scripts/generate-source-matrix.mjs'), outputFile])
    const matrix = JSON.parse(fs.readFileSync(outputFile, 'utf8')) as {
      schemaVersion: number
      sources: Array<{
        sourceId: string
        columns: { measurement: { status: string }; valuation: { status: string } }
      }>
    }

    expect(matrix.schemaVersion).toBe(2)
    expect(matrix.sources).toHaveLength(14)
    expect(matrix.sources.map((source) => ({
      sourceId: source.sourceId,
      measurement: source.columns.measurement.status,
      valuation: source.columns.valuation.status
    }))).toEqual(BUILTIN_PROVIDER_DEFINITIONS.map((definition) => ({
      sourceId: definition.sourceId,
      measurement: definition.manifest.capabilities.usage.status,
      valuation: definition.valuation.status
    })))
    expect(matrix.sources.find((source) => source.sourceId === 'opencode')?.columns.valuation.status)
      .toBe('billable-exact')
    expect(matrix.sources.find((source) => source.sourceId === 'zcode')?.columns.valuation.status)
      .toBe('billable-exact')
    expect(matrix.sources.find((source) => source.sourceId === 'gemini')?.columns.valuation.status)
      .toBe('estimate-only')
  })
})
