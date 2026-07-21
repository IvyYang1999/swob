import { describe, expect, it } from 'vitest'
import { mightContainMarkdown } from './MarkdownContent'

describe('mightContainMarkdown', () => {
  it('fast-paths plain multi-line chat text', () => {
    expect(mightContainMarkdown('Plain answer.\nSecond line (still plain).')).toBe(false)
  })

  it.each([
    '# Heading',
    '- list item',
    'Use `inline code` here',
    '**bold**',
    '[link](https://example.com)',
    'https://example.com'
  ])('keeps markdown rendering for %s', (content) => {
    expect(mightContainMarkdown(content)).toBe(true)
  })
})
