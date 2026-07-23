#!/usr/bin/env node

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import ts from 'typescript'

const TOOL_VERSION = '1.0.0'
const MAX_FILE_BYTES = 1_500_000
const MAX_OCCURRENCES_PER_FINGERPRINT = 8
const CODE_EXTENSIONS = new Set([
  '.c', '.cc', '.clj', '.cljc', '.cljs', '.cpp', '.css', '.go', '.h', '.hpp',
  '.html', '.java', '.js', '.jsx', '.kt', '.kts', '.mjs', '.cjs', '.py', '.rb',
  '.rs', '.sh', '.swift', '.svelte', '.ts', '.tsx', '.vue'
])
const TS_EXTENSIONS = new Set(['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx'])
const EXCLUDED_SEGMENTS = new Set([
  '.git', '.next', '.turbo', 'coverage', 'dist', 'generated', 'node_modules',
  'out', 'target', 'vendor', 'vendors'
])
const EXCLUDED_FILE_PATTERNS = [
  /(^|\/)(license|licence|copying|notice)(\.|$)/i,
  /(^|\/)(package-lock|npm-shrinkwrap|yarn\.lock|pnpm-lock|cargo\.lock|go\.sum)$/i,
  /\.min\.(css|js)$/i,
  /\.map$/i,
  /(^|\/)generated-manifest\.json$/i
]
const TARGET_PREFIXES = [
  'src/main/', 'src/preload/', 'src/renderer/', 'src/shared/', 'src/cli/',
  'scripts/', 'e2e/'
]
const TARGET_ROOT_FILES = new Set([
  'electron-builder.yml', 'electron.vite.config.ts', 'playwright.config.ts',
  'vitest.config.ts', 'tsconfig.json', 'tsconfig.node.json', 'tsconfig.web.json'
])
const COMMON_IDENTIFIERS = new Set([
  'addEventListener', 'className', 'createContext', 'createElement',
  'dangerouslySetInnerHTML', 'defaultValue', 'electronBuilder', 'errorMessage',
  'eventListener', 'getBoundingClientRect', 'handleClick', 'handleSubmit',
  'importMeta', 'isLoading', 'localStorage', 'node_modules', 'packageJson',
  'preventDefault', 'querySelector', 'querySelectorAll', 'removeEventListener',
  'sessionStorage', 'setInterval', 'setTimeout', 'stopPropagation',
  'useCallback', 'useContext', 'useEffect', 'useLayoutEffect', 'useMemo',
  'useReducer', 'useRef', 'useState'
])

function usage(message) {
  console.error(message)
  console.error('Usage: node scripts/compliance/t131-similarity.mjs --target <repo> --corpus <dir> --output <json> [--snapshot <label=dir>]...')
  process.exit(2)
}

function parseArgs(argv) {
  const result = { snapshots: [] }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--target') result.target = argv[++i]
    else if (arg === '--corpus') result.corpus = argv[++i]
    else if (arg === '--output') result.output = argv[++i]
    else if (arg === '--snapshot') {
      const value = argv[++i]
      const split = value.indexOf('=')
      if (split < 1) usage(`Invalid snapshot: ${value}`)
      result.snapshots.push({ label: value.slice(0, split), root: value.slice(split + 1) })
    } else if (arg === '--help') usage('')
    else usage(`Unknown argument: ${arg}`)
  }
  if (!result.target || !result.corpus || !result.output) usage('Missing required argument')
  return result
}

function posix(relativePath) {
  return relativePath.split(path.sep).join('/')
}

function shouldExclude(relativePath) {
  const normalized = posix(relativePath)
  const segments = normalized.split('/')
  if (segments.some((segment) => EXCLUDED_SEGMENTS.has(segment))) return true
  return EXCLUDED_FILE_PATTERNS.some((pattern) => pattern.test(normalized))
}

function isTargetPath(relativePath) {
  const normalized = posix(relativePath)
  if (normalized.startsWith('scripts/compliance/')) return false
  return TARGET_ROOT_FILES.has(normalized) || TARGET_PREFIXES.some((prefix) => normalized.startsWith(prefix))
}

function collectFiles(root, { targetOnly = false } = {}) {
  const collected = []
  const counters = { considered: 0, excluded: 0, oversized: 0, binary: 0, accepted: 0, bytes: 0 }
  const stack = [root]
  while (stack.length) {
    const current = stack.pop()
    let entries
    try {
      entries = fs.readdirSync(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const absolute = path.join(current, entry.name)
      const relative = posix(path.relative(root, absolute))
      if (entry.isDirectory()) {
        if (!shouldExclude(`${relative}/`)) stack.push(absolute)
        else counters.excluded += 1
        continue
      }
      if (!entry.isFile()) continue
      counters.considered += 1
      if (shouldExclude(relative) || (targetOnly && !isTargetPath(relative))) {
        counters.excluded += 1
        continue
      }
      const extension = path.extname(entry.name).toLowerCase()
      if (!CODE_EXTENSIONS.has(extension)) {
        counters.excluded += 1
        continue
      }
      const stat = fs.statSync(absolute)
      if (stat.size > MAX_FILE_BYTES) {
        counters.oversized += 1
        continue
      }
      const buffer = fs.readFileSync(absolute)
      if (buffer.includes(0)) {
        counters.binary += 1
        continue
      }
      const text = buffer.toString('utf8')
      if (/generated (file|code)|do not edit|automatically generated/i.test(text.slice(0, 600))) {
        counters.excluded += 1
        continue
      }
      collected.push({ absolute, relative, extension, text, bytes: stat.size })
      counters.accepted += 1
      counters.bytes += stat.size
    }
  }
  collected.sort((a, b) => a.relative.localeCompare(b.relative))
  return { files: collected, counters }
}

function hash(value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function normalizedLines(text) {
  const withoutBlocks = text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
  return withoutBlocks
    .split(/\r?\n/)
    .map((line) => line.replace(/(^|\s)\/\/.*$/, '$1').replace(/\s+/g, '').trim())
    .filter((line) => line.length >= 4 && !/^[{}()[\],;]+$/.test(line))
}

function genericTokens(text) {
  const withoutComments = text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|\s)\/\/.*$/gm, '$1')
    .replace(/<!--[\s\S]*?-->/g, ' ')
  return withoutComments.match(/[A-Za-z_$][A-Za-z0-9_$]*|0x[0-9A-Fa-f]+|\d+(?:\.\d+)?|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|===|!==|=>|==|!=|<=|>=|&&|\|\||\?\?|\+\+|--|\S/g) ?? []
}

function shingles(sequence, size, minimumCharacters = 0) {
  const result = []
  if (sequence.length < size) return result
  for (let index = 0; index <= sequence.length - size; index += 1) {
    const slice = sequence.slice(index, index + size)
    if (minimumCharacters && slice.reduce((total, value) => total + value.length, 0) < minimumCharacters) continue
    result.push({ fingerprint: hash(slice.join('\u001f')), index })
  }
  return result
}

function addFingerprint(index, fingerprint, occurrence) {
  const existing = index.get(fingerprint)
  if (existing === null) return
  if (!existing) {
    index.set(fingerprint, [occurrence])
    return
  }
  if (existing.length >= MAX_OCCURRENCES_PER_FINGERPRINT) {
    index.set(fingerprint, null)
    return
  }
  existing.push(occurrence)
}

function astFragments(file) {
  if (!TS_EXTENSIONS.has(file.extension)) return []
  const scriptKind = file.extension === '.tsx' || file.extension === '.jsx' ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  let source
  try {
    source = ts.createSourceFile(file.relative, file.text, ts.ScriptTarget.Latest, true, scriptKind)
  } catch {
    return []
  }
  const boundaryKinds = new Set([
    ts.SyntaxKind.FunctionDeclaration, ts.SyntaxKind.FunctionExpression,
    ts.SyntaxKind.ArrowFunction, ts.SyntaxKind.MethodDeclaration,
    ts.SyntaxKind.Constructor, ts.SyntaxKind.GetAccessor, ts.SyntaxKind.SetAccessor,
    ts.SyntaxKind.ClassDeclaration, ts.SyntaxKind.InterfaceDeclaration,
    ts.SyntaxKind.TypeAliasDeclaration
  ])
  const ignoredKinds = new Set([
    ts.SyntaxKind.Identifier, ts.SyntaxKind.PrivateIdentifier,
    ts.SyntaxKind.StringLiteral, ts.SyntaxKind.NumericLiteral,
    ts.SyntaxKind.NoSubstitutionTemplateLiteral
  ])
  const fragments = []
  function shape(node, values) {
    if (!ignoredKinds.has(node.kind)) values.push(node.kind)
    node.forEachChild((child) => shape(child, values))
  }
  function visit(node) {
    if (boundaryKinds.has(node.kind)) {
      const values = []
      shape(node, values)
      if (values.length >= 60 && values.length <= 5_000) {
        fragments.push({ fingerprint: hash(values.join(',')), nodes: values.length, position: node.pos })
      }
    }
    node.forEachChild(visit)
  }
  visit(source)
  return fragments
}

function rareTerms(file) {
  const identifiers = new Set()
  const strings = new Set()
  for (const token of genericTokens(file.text)) {
    if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(token) && token.length >= 12 && !COMMON_IDENTIFIERS.has(token)) {
      identifiers.add(token)
    } else if ((token[0] === '"' || token[0] === "'" || token[0] === '`') && token.length >= 20 && token.length <= 220) {
      const value = token.slice(1, -1).replace(/\\[nrt]/g, ' ').trim()
      if (!/^(https?:|[./@]|[A-Za-z0-9_./-]+\.(ts|tsx|js|jsx|json|css|html))/.test(value) && /[A-Za-z]{8}/.test(value)) strings.add(value)
    }
  }
  return { identifiers, strings }
}

function buildTargetIndex(targetSets) {
  const index = {
    exact: new Map(), normalized: new Map(), tokens: new Map(), ast: new Map(),
    identifiers: new Map(), strings: new Map(),
    stats: { files: 0, bytes: 0, normalizedWindows: 0, tokenWindows: 0, astFragments: 0 }
  }
  for (const set of targetSets) {
    for (const file of set.files) {
      const occurrence = { snapshot: set.label, path: file.relative }
      index.stats.files += 1
      index.stats.bytes += file.bytes
      if (file.text.length >= 200) addFingerprint(index.exact, hash(file.text), occurrence)
      const lineWindows = shingles(normalizedLines(file.text), 16, 240)
      index.stats.normalizedWindows += lineWindows.length
      for (const window of lineWindows) addFingerprint(index.normalized, window.fingerprint, { ...occurrence, index: window.index })
      const tokenWindows = shingles(genericTokens(file.text), 80, 0)
      index.stats.tokenWindows += tokenWindows.length
      for (const window of tokenWindows) addFingerprint(index.tokens, window.fingerprint, { ...occurrence, index: window.index })
      const fragments = astFragments(file)
      index.stats.astFragments += fragments.length
      for (const fragment of fragments) addFingerprint(index.ast, fragment.fingerprint, { ...occurrence, nodes: fragment.nodes, position: fragment.position })
      const terms = rareTerms(file)
      for (const value of terms.identifiers) addFingerprint(index.identifiers, hash(value), occurrence)
      for (const value of terms.strings) addFingerprint(index.strings, hash(value), occurrence)
    }
  }
  return index
}

function repoMetadata(repoRoot) {
  const remote = execFileSync('git', ['-C', repoRoot, 'remote', 'get-url', 'origin'], { encoding: 'utf8' }).trim()
  const repository = remote.replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, '')
  const commit = execFileSync('git', ['-C', repoRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  const committedAt = execFileSync('git', ['-C', repoRoot, 'show', '-s', '--format=%cI', 'HEAD'], { encoding: 'utf8' }).trim()
  return { repository, commit, committedAt }
}

function pairKey(target, repository, externalPath) {
  return `${target.snapshot}\u0000${target.path}\u0000${repository}\u0000${externalPath}`
}

function findingFor(map, target, repository, externalPath) {
  const key = pairKey(target, repository, externalPath)
  let finding = map.get(key)
  if (!finding) {
    finding = {
      targetSnapshot: target.snapshot,
      targetPath: target.path,
      externalRepository: repository,
      externalPath,
      exactFile: false,
      normalized16LineWindows: 0,
      token80Windows: 0,
      exactAstFragments: 0,
      largestAstFragmentNodes: 0,
      rareIdentifierMatches: 0,
      rareStringMatches: 0,
      evidenceLocations: { normalized: [], tokens: [], ast: [] }
    }
    map.set(key, finding)
  }
  return finding
}

function matchOccurrences(findings, occurrences, repository, externalPath, update) {
  if (!occurrences) return
  for (const target of occurrences) update(findingFor(findings, target, repository, externalPath), target)
}

function scanExternalFile(file, repository, targetIndex, findings) {
  matchOccurrences(findings, targetIndex.exact.get(hash(file.text)), repository, file.relative, (finding) => { finding.exactFile = true })
  for (const window of shingles(normalizedLines(file.text), 16, 240)) {
    matchOccurrences(findings, targetIndex.normalized.get(window.fingerprint), repository, file.relative, (finding, target) => {
      finding.normalized16LineWindows += 1
      if (finding.evidenceLocations.normalized.length < 3) finding.evidenceLocations.normalized.push({ targetIndex: target.index, externalIndex: window.index })
    })
  }
  for (const window of shingles(genericTokens(file.text), 80, 0)) {
    matchOccurrences(findings, targetIndex.tokens.get(window.fingerprint), repository, file.relative, (finding, target) => {
      finding.token80Windows += 1
      if (finding.evidenceLocations.tokens.length < 3) finding.evidenceLocations.tokens.push({ targetIndex: target.index, externalIndex: window.index })
    })
  }
  for (const fragment of astFragments(file)) {
    matchOccurrences(findings, targetIndex.ast.get(fragment.fingerprint), repository, file.relative, (finding, target) => {
      finding.exactAstFragments += 1
      finding.largestAstFragmentNodes = Math.max(finding.largestAstFragmentNodes, fragment.nodes)
      if (finding.evidenceLocations.ast.length < 3) finding.evidenceLocations.ast.push({ targetPosition: target.position, externalPosition: fragment.position, nodes: fragment.nodes })
    })
  }
  const terms = rareTerms(file)
  for (const value of terms.identifiers) {
    matchOccurrences(findings, targetIndex.identifiers.get(hash(value)), repository, file.relative, (finding) => { finding.rareIdentifierMatches += 1 })
  }
  for (const value of terms.strings) {
    matchOccurrences(findings, targetIndex.strings.get(hash(value)), repository, file.relative, (finding) => { finding.rareStringMatches += 1 })
  }
}

function score(finding) {
  return (finding.exactFile ? 10_000 : 0)
    + finding.normalized16LineWindows * 80
    + finding.token80Windows * 20
    + finding.exactAstFragments * 120
    + Math.min(finding.largestAstFragmentNodes, 2_000)
    + finding.rareIdentifierMatches * 15
    + finding.rareStringMatches * 30
}

function requiresManualReview(finding) {
  return finding.exactFile
    || finding.normalized16LineWindows >= 1
    || finding.token80Windows >= 4
    || finding.exactAstFragments >= 1
    || (finding.rareStringMatches >= 2 && finding.rareIdentifierMatches >= 2)
}

const args = parseArgs(process.argv.slice(2))
const targetRoot = path.resolve(args.target)
const corpusRoot = path.resolve(args.corpus)
const targetSets = []
const current = collectFiles(targetRoot, { targetOnly: true })
targetSets.push({ label: 'current', root: targetRoot, files: current.files, counters: current.counters })
for (const snapshot of args.snapshots) {
  const root = path.resolve(snapshot.root)
  const collected = collectFiles(root, { targetOnly: true })
  targetSets.push({ label: snapshot.label, root, files: collected.files, counters: collected.counters })
}

const targetIndex = buildTargetIndex(targetSets)
const findings = new Map()
const repositories = []
for (const entry of fs.readdirSync(corpusRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
  const root = path.join(corpusRoot, entry.name)
  if (!fs.existsSync(path.join(root, '.git'))) continue
  const metadata = repoMetadata(root)
  const collected = collectFiles(root)
  for (const file of collected.files) scanExternalFile(file, metadata.repository, targetIndex, findings)
  repositories.push({ ...metadata, scan: collected.counters })
}

const selectedFindings = [...findings.values()]
  .filter(requiresManualReview)
  .map((finding) => ({ ...finding, score: score(finding), disposition: 'manual-review-required' }))
  .sort((a, b) => b.score - a.score || a.externalRepository.localeCompare(b.externalRepository) || a.targetPath.localeCompare(b.targetPath))

const output = {
  schemaVersion: 1,
  tool: { name: 'swob-t131-similarity', version: TOOL_VERSION, node: process.version, typescript: ts.version },
  baseline: {
    commit: execFileSync('git', ['-C', targetRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    generatedAt: new Date().toISOString()
  },
  privacy: 'No source snippets, literal matches, transcript bodies, credentials, or environment values are included.',
  target: {
    scopes: TARGET_PREFIXES.concat([...TARGET_ROOT_FILES]),
    snapshots: targetSets.map((set) => ({ label: set.label, counters: set.counters })),
    fingerprints: targetIndex.stats
  },
  exclusions: {
    segments: [...EXCLUDED_SEGMENTS].sort(),
    rationale: [
      'Dependencies, vendored code, build output, generated content, lockfiles, source maps, and minified files are excluded.',
      'License/NOTICE/COPYING texts are excluded because their mandated verbatim similarity is not evidence of source copying.',
      `Fingerprints appearing more than ${MAX_OCCURRENCES_PER_FINGERPRINT} times in the target are discarded as boilerplate.`,
      'AST matches require an exact identifier/literal-free TypeScript/JavaScript subtree of at least 60 nodes.',
      'All reported matches require human review; similarity alone is not a legal conclusion.'
    ]
  },
  repositories,
  findingCount: selectedFindings.length,
  findings: selectedFindings
}

fs.mkdirSync(path.dirname(path.resolve(args.output)), { recursive: true })
fs.writeFileSync(path.resolve(args.output), `${JSON.stringify(output, null, 2)}\n`)
console.log(JSON.stringify({ output: path.resolve(args.output), repositories: repositories.length, findings: selectedFindings.length, targetFiles: targetIndex.stats.files }, null, 2))
