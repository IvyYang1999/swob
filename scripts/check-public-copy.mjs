import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const fixedPublicFiles = [
  'README.md',
  'README.zh.md',
  'README.ja.md',
  'site/index.html',
  'site/zh/index.html'
]

const publicFiles = fixedPublicFiles
const contentByFile = new Map(
  publicFiles.map((file) => [file, fs.readFileSync(path.join(root, file), 'utf8')])
)

const errors = []
const providerSource = fs.readFileSync(
  path.join(root, 'src/shared/provider-capabilities.ts'),
  'utf8'
)
const definitionPattern = /definition\('([^']+)',\s*'([^']+)',\s*'(native|compatible|detection-only)'/g
const providers = [...providerSource.matchAll(definitionPattern)].map((match) => ({
  sourceId: match[1],
  displayName: match[2],
  tier: match[3]
}))

for (const [tier, expected] of [['native', 6], ['compatible', 1], ['detection-only', 4]]) {
  const actual = providers.filter((provider) => provider.tier === tier).length
  if (actual !== expected) {
    errors.push(`provider registry tier ${tier}: expected ${expected}, found ${actual}`)
  }
}

const normalize = (value) => value.toLocaleLowerCase('en-US').replace(/[^\p{L}\p{N}]/gu, '')

for (const file of fixedPublicFiles) {
  const content = contentByFile.get(file)
  const normalized = normalize(content)
  for (const provider of providers) {
    if (!normalized.includes(normalize(provider.displayName))) {
      errors.push(`${file}: missing provider ${provider.displayName}`)
    }
  }
}

for (const file of ['README.md', 'README.zh.md', 'README.ja.md']) {
  const content = contentByFile.get(file)
  if (!content.includes('src/shared/provider-capabilities.ts')) {
    errors.push(`${file}: does not link the canonical provider capability registry`)
  }
}

for (const file of ['site/index.html', 'site/zh/index.html']) {
  const content = contentByFile.get(file)
  if (!content.includes('src/shared/provider-capabilities.ts')) {
    errors.push(`${file}: does not name the canonical provider capability registry`)
  }
}

const forbidden = [
  [/\b11[- ]harness(?:es)?\b/i, 'must not market 11 harnesses as one ingestion tier'],
  [/\beleven local harness sources?\b/i, 'must not market eleven harnesses as one ingestion tier'],
  [/\bnatively reads?\s+5\s+harness(?:es)?\b/i, 'current main has 6 native providers, not 5'],
  [/原生读取\s*5\s*种\s*harness|5\s*種の harness をネイティブ/i, 'current main has 6 native providers, not 5'],
  [/\bexperimentally detects? files from 5\b/i, 'current main has 4 detection-only providers, not 5'],
  [/5\s*种实验性文件检测|5\s*種を実験的にファイル検出/, 'current main has 4 detection-only providers, not 5'],
  [/search(?:es|ing)?[^.\n]{0,80}\b11\b[^.\n]{0,40}(?:harness|source)/i, 'must not claim search across 11 sources'],
  [/检索[^。\n]{0,60}11\s*类|11\s*类[^。\n]{0,60}(?:导入|检索|历史)/, 'must not claim 11 readable Chinese sources'],
  [/11\s*種類[^。\n]{0,60}(?:取り込み|検索|履歴)/, 'must not claim 11 readable Japanese sources'],
  [/indexes every message/i, 'must not claim every detected message is indexed'],
  [/索引全部消息|全メッセージ[^。\n]{0,40}索引/, 'must not claim every detected message is indexed'],
  [/ChatGPT\s*\((?:via export|通过导出)\)/i, 'ChatGPT import is not a verified current capability'],
  [/Most AI tools[^.\n]{0,80}30 days|大多数 AI 工具[^。\n]{0,80}30 天/i, 'the 30-day default is verified for Claude Code only'],
  [/one[- ]click[^.\n]{0,100}(?:restore|recover)[^.\n]{0,100}continue|一键[^。\n]{0,80}(?:恢复|复活)[^。\n]{0,80}继续/i, 'recovery is conditional, not universally one-click'],
  [/how much spent|花了多少钱/i, 'API equivalent value is not an actual bill'],
  [/Your session data stays on your computer|会话数据[^。\n]{0,40}(?:只|仅)[^。\n]{0,40}(?:电脑|本机)/i, 'local-first copy must retain optional network boundaries']
]

for (const [file, content] of contentByFile) {
  for (const [pattern, message] of forbidden) {
    if (pattern.test(content)) errors.push(`${file}: ${message}`)
  }
}

const packageVersion = JSON.parse(
  fs.readFileSync(path.join(root, 'package.json'), 'utf8')
).version
const directDownloadPattern = /https:\/\/github\.com\/IvyYang1999\/swob\/releases\/download\/v([^/"'\s]+)\/swob-([^/"'\s]+)-(arm64|x64)\.dmg/g
for (const [file, content] of contentByFile) {
  for (const match of content.matchAll(directDownloadPattern)) {
    if (match[1] !== packageVersion || match[2] !== packageVersion) {
      errors.push(`${file}: direct installer URL must match package version ${packageVersion}`)
    }
  }
}
for (const file of ['site/index.html', 'site/zh/index.html']) {
  const content = contentByFile.get(file)
  const jsonLdText = content.match(/<script type="application\/ld\+json">\s*([\s\S]*?)\s*<\/script>/)?.[1]
  if (!jsonLdText) {
    errors.push(`${file}: missing SoftwareApplication JSON-LD`)
    continue
  }
  const software = JSON.parse(jsonLdText)
  if (software.softwareVersion === '1.2.0' && !/agpl-3\.0/i.test(software.license ?? '')) {
    errors.push(`${file}: the public v1.2.0 SoftwareApplication must retain its AGPL-3.0 license`)
  }
  if (/^1\.(?:[3-9]|\d{2,})\./.test(software.softwareVersion ?? '') && !/apache.*2\.0/i.test(software.license ?? '')) {
    errors.push(`${file}: a public v1.3.0+ SoftwareApplication must use Apache-2.0`)
  }
}

const packageLicense = JSON.parse(
  fs.readFileSync(path.join(root, 'package.json'), 'utf8')
).license
const combinedFixedCopy = fixedPublicFiles.map((file) => contentByFile.get(file)).join('\n')

if (packageLicense === 'AGPL-3.0-only') {
  if (!fixedPublicFiles.every((file) => /AGPL-3\.0/i.test(contentByFile.get(file)))) {
    errors.push('public entry points must match the current AGPL-3.0-only package license')
  }
} else if (packageLicense === 'Apache-2.0') {
  if (!fixedPublicFiles.every((file) => /Apache(?:-|\s+License\s+)2\.0/i.test(contentByFile.get(file)))) {
    errors.push('public entry points must match the current Apache-2.0 package license')
  }
  if (!/v1\.3\.0[^\n]{0,120}Apache-2\.0|Apache-2\.0[^\n]{0,120}v1\.3\.0/i.test(combinedFixedCopy)) {
    errors.push('Apache copy must state the v1.3.0 effective boundary')
  }
} else {
  errors.push(`unsupported package license in public-copy gate: ${packageLicense}`)
}

if (errors.length > 0) {
  console.error('Public copy gate failed:')
  for (const error of errors) console.error(`- ${error}`)
  process.exit(1)
}

console.log(
  `Public copy gate passed: ${providers.length} providers (${providers.filter((p) => p.tier === 'native').length}+${providers.filter((p) => p.tier === 'compatible').length}+${providers.filter((p) => p.tier === 'detection-only').length}), ${publicFiles.length} public files, license ${packageLicense}.`
)
