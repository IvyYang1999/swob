import { describe, expect, it } from 'vitest'
import { DEFAULT_TOOL_COLOR, getToolPreview, TOOL_COLORS } from './tools'

describe('getToolPreview', () => {
  it('truncates Bash commands to 120 characters', () => {
    expect(getToolPreview('Bash', { command: 'x'.repeat(121) })).toBe('x'.repeat(120))
  })

  it('retains the current full-path preview for file tools', () => {
    expect(getToolPreview('Read', { file_path: '/project/src/index.ts' })).toBe('/project/src/index.ts')
    expect(getToolPreview('Write', { file_path: '/tmp/output.ts' })).toBe('/tmp/output.ts')
    expect(getToolPreview('Edit', { file_path: '/project/a.ts' })).toBe('/project/a.ts')
  })

  it('previews search patterns, skills, and truncated agent prompts', () => {
    expect(getToolPreview('Grep', { pattern: 'TODO' })).toBe('TODO')
    expect(getToolPreview('Glob', { pattern: '**/*.ts' })).toBe('**/*.ts')
    expect(getToolPreview('Skill', { skill: 'review' })).toBe('review')
    expect(getToolPreview('Agent', { prompt: 'a'.repeat(81) })).toBe('a'.repeat(80))
  })

  it('returns an empty preview for unsupported or incomplete calls', () => {
    expect(getToolPreview('WebFetch', { url: 'https://example.com' })).toBe('')
    expect(getToolPreview('Bash', {})).toBe('')
  })
})

describe('tool colors', () => {
  it('defines stable classes for known tools and a fallback', () => {
    expect(TOOL_COLORS.Bash).toContain('soft-green')
    expect(TOOL_COLORS.Read).toContain('soft-blue')
    expect(DEFAULT_TOOL_COLOR).toContain('bg-surface')
  })
})
