#!/usr/bin/env node

import { execFileSync } from 'node:child_process'

function argument(name) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

export function hasMatchingSignoff({ authorName, authorEmail, body }) {
  const signoffs = [...body.matchAll(/^Signed-off-by:\s*(.+?)\s*<([^>]+)>\s*$/gim)]
  return signoffs.some(([, name, email]) =>
    name.trim().length > 0 &&
    email.trim().toLocaleLowerCase('en-US') === authorEmail.trim().toLocaleLowerCase('en-US') &&
    name.trim() === authorName.trim()
  )
}

function selfTest() {
  const commit = {
    authorName: 'Example Contributor',
    authorEmail: 'contributor@example.com',
    body: 'feat: example\n\nSigned-off-by: Example Contributor <contributor@example.com>\n'
  }
  if (!hasMatchingSignoff(commit)) throw new Error('valid DCO trailer was rejected')
  if (hasMatchingSignoff({ ...commit, body: 'feat: unsigned\n' })) throw new Error('unsigned commit was accepted')
  if (hasMatchingSignoff({ ...commit, body: 'Signed-off-by: Other Person <other@example.com>\n' })) {
    throw new Error('mismatched DCO trailer was accepted')
  }
  console.log('DCO checker self-test passed.')
}

if (process.argv.includes('--self-test')) {
  selfTest()
  process.exit(0)
}

const base = argument('--base')
const head = argument('--head')
if (!base || !head) {
  console.error('Usage: node scripts/check-dco.mjs --base <base-sha> --head <head-sha>')
  process.exit(2)
}

const recordSeparator = '\u001e'
const fieldSeparator = '\u001f'
const output = execFileSync(
  'git',
  ['log', '--no-merges', `--format=%H%x1f%an%x1f%ae%x1f%B%x1e`, `${base}..${head}`],
  { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }
)
const commits = output
  .split(recordSeparator)
  .map((record) => record.trim())
  .filter(Boolean)
  .map((record) => {
    const [sha, authorName, authorEmail, ...body] = record.split(fieldSeparator)
    return { sha, authorName, authorEmail, body: body.join(fieldSeparator) }
  })

const unsigned = commits.filter((commit) => !hasMatchingSignoff(commit))
if (unsigned.length > 0) {
  console.error('DCO check failed. These non-merge commits lack an author-matching Signed-off-by trailer:')
  for (const commit of unsigned) console.error(`- ${commit.sha} (${commit.authorName} <${commit.authorEmail}>)`)
  process.exit(1)
}

console.log(`DCO check passed for ${commits.length} non-merge commit(s).`)
