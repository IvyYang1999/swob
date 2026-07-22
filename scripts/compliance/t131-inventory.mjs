#!/usr/bin/env node

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const args = process.argv.slice(2)
const valueFor = (name, fallback) => {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : fallback
}
const repoRoot = path.resolve(valueFor('--repo', '.'))
const outputRoot = path.resolve(valueFor('--output-dir', path.join(repoRoot, 'compliance/t131')))
const baseline = git(['rev-parse', 'HEAD']).trim()

function git(command, options = {}) {
  return execFileSync('git', ['-C', repoRoot, ...command], { encoding: options.encoding ?? 'utf8', maxBuffer: 64 * 1024 * 1024 })
}

function writeJson(name, value) {
  fs.writeFileSync(path.join(outputRoot, name), `${JSON.stringify(value, null, 2)}\n`)
}

function csvCell(value) {
  const text = value == null ? '' : String(value)
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

function writeCsv(name, headers, rows) {
  const lines = [headers.map(csvCell).join(',')]
  for (const row of rows) lines.push(headers.map((header) => csvCell(row[header])).join(','))
  fs.writeFileSync(path.join(outputRoot, name), `${lines.join('\n')}\n`)
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex')
}

function rightsChain() {
  const raw = git(['log', 'HEAD', '--format=__COMMIT__%x00%an%x00%ae%x00%aI%x00%P', '--numstat'])
  const identities = new Map()
  let current
  for (const line of raw.split('\n')) {
    if (line.startsWith('__COMMIT__\u0000')) {
      const [, name, email, date, parents] = line.split('\u0000')
      const identity = `${name}\u0000${email}`
      current = identities.get(identity) ?? {
        commits: 0, mergeCommits: 0, additions: 0, deletions: 0,
        binaryChanges: 0, firstCommitAt: date, lastCommitAt: date
      }
      current.commits += 1
      if (parents.trim().split(/\s+/).filter(Boolean).length > 1) current.mergeCommits += 1
      if (date < current.firstCommitAt) current.firstCommitAt = date
      if (date > current.lastCommitAt) current.lastCommitAt = date
      identities.set(identity, current)
      continue
    }
    if (!current || !line) continue
    const [added, deleted] = line.split('\t')
    if (added === '-' || deleted === '-') current.binaryChanges += 1
    else if (/^\d+$/.test(added) && /^\d+$/.test(deleted)) {
      current.additions += Number(added)
      current.deletions += Number(deleted)
    }
  }
  const sorted = [...identities.values()].sort((a, b) => (b.additions + b.deletions) - (a.additions + a.deletions))
  let unresolved = 0
  const authors = sorted.map((author, index) => {
    let label
    if (author.additions === 0 && author.deletions === 0 && author.commits === author.mergeCommits) label = 'MERGE_AUTOMATION'
    else if (index === 0) label = 'PROJECT_OWNER'
    else label = `UNRESOLVED_AUTHOR_${++unresolved}`
    return { label, ...author }
  })
  return {
    schemaVersion: 1,
    baseline,
    scope: 'Commits reachable from the audited HEAD only; identities are intentionally anonymized.',
    distinctAuthorIdentities: authors.length,
    unresolvedAuthorIdentities: unresolved,
    authors,
    evidenceLimit: 'Git metadata cannot distinguish AI-assisted changes committed under the project-owner identity. A separate owner attestation is required.'
  }
}

function dependencyInventory() {
  const lock = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package-lock.json'), 'utf8'))
  const rows = []
  for (const [lockPath, metadata] of Object.entries(lock.packages ?? {})) {
    if (!lockPath) continue
    const name = metadata.name ?? lockPath.replace(/^node_modules\//, '')
    const license = metadata.license ?? 'UNKNOWN'
    let review = 'permissive-or-public-domain'
    if (/MPL|GPL|AGPL|LGPL|EPL|CDDL/i.test(license)) review = 'manual-copyleft-review'
    else if (/BUSL|Elastic|SSPL|SEE LICENSE|UNKNOWN|UNLICENSED/i.test(license)) review = 'blocker-until-resolved'
    else if (/CC-BY/i.test(license)) review = 'manual-attribution-review'
    rows.push({
      group: metadata.dev === true ? 'development' : 'production',
      name,
      version: metadata.version ?? '',
      license,
      optional: metadata.optional === true,
      installScript: metadata.hasInstallScript === true,
      review,
      lockPath
    })
  }
  rows.sort((a, b) => a.group.localeCompare(b.group) || a.name.localeCompare(b.name) || a.version.localeCompare(b.version))
  const byGroupAndLicense = {}
  const reviewCounts = {}
  for (const row of rows) {
    const groupKey = `${row.group}|${row.license}`
    byGroupAndLicense[groupKey] = (byGroupAndLicense[groupKey] ?? 0) + 1
    reviewCounts[row.review] = (reviewCounts[row.review] ?? 0) + 1
  }
  return { rows, summary: { schemaVersion: 1, baseline, lockfileVersion: lock.lockfileVersion, packageEntries: rows.length, byGroupAndLicense, reviewCounts } }
}

function imageDimensions(buffer, extension) {
  if (extension === '.png' && buffer.length >= 24 && buffer.subarray(1, 4).toString() === 'PNG') {
    return `${buffer.readUInt32BE(16)}x${buffer.readUInt32BE(20)}`
  }
  if (extension === '.svg') {
    const text = buffer.toString('utf8', 0, Math.min(buffer.length, 4096))
    const viewBox = text.match(/viewBox=["']([^"']+)["']/i)?.[1]
    return viewBox ? `viewBox:${viewBox}` : ''
  }
  if (extension === '.webp' && buffer.subarray(0, 4).toString() === 'RIFF') {
    const chunk = buffer.subarray(12, 16).toString()
    if (chunk === 'VP8X' && buffer.length >= 30) {
      const width = 1 + buffer.readUIntLE(24, 3)
      const height = 1 + buffer.readUIntLE(27, 3)
      return `${width}x${height}`
    }
  }
  return ''
}

function assetCategory(assetPath) {
  if (/src\/renderer\/src\/assets\/icons\/(claude|cursor|openai)\.png$/.test(assetPath)) return ['third-party-brand-icon', 'BLOCKER_SOURCE_AND_REDISTRIBUTION_TERMS_UNKNOWN']
  if (/\.webp$/i.test(assetPath)) return ['generated-image-derivative', 'BLOCKED_BY_SOURCE_PNG_CLEARANCE']
  if (/^(docs|site\/assets)\/.*\.(png|jpg|jpeg)$/i.test(assetPath)) return ['product-or-marketing-capture', 'BLOCKER_CAPTURE_AND_SANITIZATION_ATTESTATION_MISSING']
  if (/^(build\/icon|site\/assets\/favicon)/.test(assetPath)) return ['project-brand-asset', 'BLOCKER_CREATION_SOURCE_ATTESTATION_MISSING']
  return ['other-asset', 'MANUAL_REVIEW']
}

function assetInventory() {
  const assetPattern = /\.(png|webp|jpe?g|gif|svg|ico|icns|woff2?|ttf|otf)$/i
  const paths = git(['ls-files', '-z']).split('\u0000').filter((file) => assetPattern.test(file))
  return paths.map((assetPath) => {
    const absolute = path.join(repoRoot, assetPath)
    const buffer = fs.readFileSync(absolute)
    const extension = path.extname(assetPath).toLowerCase()
    const additions = git(['log', '--diff-filter=A', '--follow', '--format=%H%x09%aI%x09%s', '--', assetPath]).trim().split('\n').filter(Boolean)
    const first = (additions.at(-1) ?? '').split('\t')
    const [category, disposition] = assetCategory(assetPath)
    return {
      path: assetPath,
      category,
      bytes: buffer.length,
      dimensions: imageDimensions(buffer, extension),
      sha256: sha256(buffer),
      firstCommit: first[0] ?? '',
      firstCommitAt: first[1] ?? '',
      firstCommitSubject: first.slice(2).join('\t'),
      repositoryEvidence: 'No machine-readable source URL, license, or generator manifest found next to the asset.',
      disposition
    }
  }).sort((a, b) => a.path.localeCompare(b.path))
}

function scopeInventory() {
  const tracked = git(['ls-files', '-z']).split('\u0000').filter(Boolean)
  const byTopLevel = {}
  const byExtension = {}
  for (const file of tracked) {
    const top = file.includes('/') ? file.split('/')[0] : '[root]'
    const extension = path.extname(file).toLowerCase() || '[none]'
    byTopLevel[top] = (byTopLevel[top] ?? 0) + 1
    byExtension[extension] = (byExtension[extension] ?? 0) + 1
  }
  return { schemaVersion: 1, baseline, trackedFiles: tracked.length, byTopLevel, byExtension }
}

fs.mkdirSync(outputRoot, { recursive: true })
writeJson('rights-chain.json', rightsChain())
const dependencies = dependencyInventory()
writeJson('dependency-license-summary.json', dependencies.summary)
writeCsv('dependency-license-inventory.csv', ['group', 'name', 'version', 'license', 'optional', 'installScript', 'review', 'lockPath'], dependencies.rows)
const assets = assetInventory()
writeCsv('asset-provenance.csv', ['path', 'category', 'bytes', 'dimensions', 'sha256', 'firstCommit', 'firstCommitAt', 'firstCommitSubject', 'repositoryEvidence', 'disposition'], assets)
writeJson('scope-inventory.json', scopeInventory())

console.log(JSON.stringify({ baseline, outputRoot, dependencies: dependencies.rows.length, assets: assets.length }, null, 2))
