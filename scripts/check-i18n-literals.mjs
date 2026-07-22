import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { createHash } from 'node:crypto'
import ts from 'typescript'

const projectRoot = process.cwd()
const rendererRoot = path.join(projectRoot, 'src/renderer/src')
const allowlistPath = path.join(projectRoot, 'scripts/i18n-literal-allowlist.json')
const cjkPattern = /[\u3040-\u30ff\u3400-\u9fff]/u

function sourceFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name)
    if (entry.isDirectory()) return sourceFiles(entryPath)
    if (!/\.(?:ts|tsx)$/.test(entry.name)) return []
    if (/\.(?:test|spec)\.(?:ts|tsx)$/.test(entry.name)) return []
    return [entryPath]
  })
}

function literalTexts(node) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return [node.text]
  if (ts.isJsxText(node)) return [node.getText()]
  if (ts.isTemplateExpression(node)) {
    return [node.head.text, ...node.templateSpans.map((span) => span.literal.text)]
  }
  return []
}

function findViolations() {
  const violations = []
  for (const absolutePath of sourceFiles(rendererRoot)) {
    const relativePath = path.relative(projectRoot, absolutePath).split(path.sep).join('/')
    const sourceText = fs.readFileSync(absolutePath, 'utf8')
    const sourceFile = ts.createSourceFile(
      absolutePath,
      sourceText,
      ts.ScriptTarget.Latest,
      true,
      absolutePath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
    )
    const visit = (node) => {
      for (const text of literalTexts(node)) {
        if (!cjkPattern.test(text)) continue
        const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
        violations.push({ file: relativePath, line: line + 1, text: text.trim() })
      }
      ts.forEachChild(node, visit)
    }
    visit(sourceFile)
  }
  return violations
}

function groupedEntries(violations, reason) {
  const groups = new Map()
  for (const violation of violations) {
    const key = `${violation.file}\u0000${violation.text}`
    const current = groups.get(key)
    if (current) current.count += 1
    else groups.set(key, { file: violation.file, text: violation.text, count: 1, reason })
  }
  return [...groups.values()].sort((a, b) =>
    a.file.localeCompare(b.file) || a.text.localeCompare(b.text)
  )
}

function violationsDigest(violations) {
  return createHash('sha256')
    .update(JSON.stringify(groupedEntries(violations, '')))
    .digest('hex')
}

const violations = findViolations()

if (process.argv.includes('--write-baseline')) {
  const baseline = {
    description: 'Exact, counted exceptions for non-translatable CJK literals. New literals still fail.',
    temporaryMigrationBaseline: {
      count: violations.length,
      digest: violationsDigest(violations),
      reason: 'T122 architecture commit only; removed by the renderer migration commit'
    },
    entries: []
  }
  fs.writeFileSync(allowlistPath, `${JSON.stringify(baseline, null, 2)}\n`, 'utf8')
  console.log(`Wrote a temporary migration baseline for ${violations.length} literals.`)
  process.exit(0)
}

const allowlist = JSON.parse(fs.readFileSync(allowlistPath, 'utf8'))
if (allowlist.temporaryMigrationBaseline) {
  const baseline = allowlist.temporaryMigrationBaseline
  if (baseline.count === violations.length && baseline.digest === violationsDigest(violations)) {
    console.log(`Renderer i18n literal check passed against the temporary migration baseline (${violations.length} literals).`)
    process.exit(0)
  }
  console.error('Renderer i18n literals changed without removing/updating the temporary migration baseline.')
  process.exit(1)
}
const actualEntries = groupedEntries(violations, '')
const actualByKey = new Map(actualEntries.map((entry) => [`${entry.file}\u0000${entry.text}`, entry]))
const allowedByKey = new Map(allowlist.entries.map((entry) => [`${entry.file}\u0000${entry.text}`, entry]))
const failures = []

for (const actual of actualEntries) {
  const key = `${actual.file}\u0000${actual.text}`
  const allowed = allowedByKey.get(key)
  if (!allowed || allowed.count !== actual.count) {
    failures.push({ ...actual, allowedCount: allowed?.count || 0 })
  }
}

for (const allowed of allowlist.entries) {
  const key = `${allowed.file}\u0000${allowed.text}`
  if (!actualByKey.has(key)) {
    failures.push({ ...allowed, allowedCount: allowed.count, stale: true })
  }
}

if (failures.length > 0) {
  console.error('Renderer i18n literal check failed:')
  for (const failure of failures) {
    if (failure.stale) {
      console.error(`- stale allowlist: ${failure.file} :: ${JSON.stringify(failure.text)}`)
    } else {
      console.error(`- ${failure.file} :: ${JSON.stringify(failure.text)} (found ${failure.count}, allowed ${failure.allowedCount})`)
    }
  }
  process.exit(1)
}

console.log(`Renderer i18n literal check passed: ${violations.length} allowlisted, 0 unallowlisted.`)
