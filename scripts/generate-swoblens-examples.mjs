import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const root = process.cwd()
const examplesDir = path.join(root, 'docs', 'swoblens', 'examples')
const maliciousDir = path.join(root, 'testdata', 'swoblens', 'malicious')
const check = process.argv.includes('--check')

const CRC_TABLE = new Uint32Array(256)
for (let index = 0; index < CRC_TABLE.length; index++) {
  let value = index
  for (let bit = 0; bit < 8; bit++) value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
  CRC_TABLE[index] = value >>> 0
}

function crc32(buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function json(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`)
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function zip(entries) {
  const localParts = []
  const centralParts = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name)
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data)
    const extra = entry.extra || Buffer.alloc(0)
    const declaredCompressed = entry.declaredCompressedSize ?? data.length
    const declaredUncompressed = entry.declaredUncompressedSize ?? data.length
    const declaredCrc = entry.declaredCrc ?? crc32(data)
    const flags = 0x0800
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(flags, 6)
    local.writeUInt16LE(0, 8)
    local.writeUInt32LE(declaredCrc, 14)
    local.writeUInt32LE(declaredCompressed, 18)
    local.writeUInt32LE(declaredUncompressed, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(extra.length, 28)
    localParts.push(local, name, extra, data)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE((3 << 8) | 20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(flags, 8)
    central.writeUInt16LE(0, 10)
    central.writeUInt32LE(declaredCrc, 16)
    central.writeUInt32LE(declaredCompressed, 20)
    central.writeUInt32LE(declaredUncompressed, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt16LE(extra.length, 30)
    central.writeUInt32LE((entry.externalAttributes ?? (0o100600 << 16)) >>> 0, 38)
    central.writeUInt32LE(offset, 42)
    centralParts.push(central, name, extra)
    offset += local.length + name.length + extra.length + data.length
  }
  const centralDirectory = Buffer.concat(centralParts)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(centralDirectory.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...localParts, centralDirectory, eocd])
}

function packageEntries({ id, name, version = '1.0.0', type, author = 'Swob', minSwobVersion = '1.3.1', declarationName, declaration, extraManifest = {} }) {
  const declarationData = json(declaration)
  const manifest = {
    schemaVersion: 1,
    id,
    name,
    version,
    type,
    author,
    minSwobVersion,
    declaration: declarationName,
    files: [{ path: declarationName, sha256: sha256(declarationData), bytes: declarationData.length }],
    ...extraManifest
  }
  return [
    { name: 'manifest.json', data: json(manifest) },
    { name: declarationName, data: declarationData }
  ]
}

const samples = {
  'aurora-calm.swoblens': packageEntries({
    id: 'swob.aurora-calm',
    name: { 'zh-CN': '极光静谧', en: 'Aurora Calm' },
    type: 'theme',
    declarationName: 'theme.json',
    declaration: {
      schemaVersion: 1,
      label: { 'zh-CN': '极光静谧', en: 'Aurora Calm' },
      mode: 'both',
      tokens: {
        base: '#111827', surface: '#1f2937', hover: '#374151', pressed: '#4b5563',
        primary: '#e5e7eb', secondary: '#9ca3af', edge: '#374151', accent: '#67e8f9', active: '#6ee7b7'
      }
    }
  }),
  'research-kit.swoblens': packageEntries({
    id: 'swob.research-kit',
    name: { 'zh-CN': '学术研究套装', en: 'Research Kit' },
    type: 'lens-preset',
    declarationName: 'lens-preset.json',
    declaration: {
      schemaVersion: 1,
      label: { 'zh-CN': '学术研究套装', en: 'Research Kit' },
      enabledLenses: ['highlights', 'image-index', 'outputs', 'share-templates'],
      order: ['highlights', 'image-index', 'outputs', 'share-templates', 'token-insights', 'galaxy', 'audit'],
      sceneTags: ['knowledge']
    }
  }),
  'field-notes-card.swoblens': packageEntries({
    id: 'swob.field-notes-card',
    name: { 'zh-CN': '田野笔记卡', en: 'Field Notes Card' },
    type: 'share-template',
    declarationName: 'share-template.json',
    declaration: {
      schemaVersion: 1,
      label: { 'zh-CN': '田野笔记卡', en: 'Field Notes Card' },
      layout: 'compact',
      watermark: 'Captured with Swob',
      colors: {
        bg: 'base', cardBg: 'surface', text: 'primary', textSecondary: 'secondary',
        textMuted: 'muted', userAccent: 'soft-blue', assistantAccent: 'soft-orange', border: 'edge'
      }
    }
  })
}

const validThemeEntries = packageEntries({
  id: 'fixture.valid-theme',
  name: { 'zh-CN': '测试主题', en: 'Fixture Theme' },
  type: 'theme',
  declarationName: 'theme.json',
  declaration: {
    schemaVersion: 1,
    label: { 'zh-CN': '测试主题', en: 'Fixture Theme' },
    mode: 'both',
    tokens: { base: '#111111', surface: '#222222', primary: '#eeeeee', accent: '#8888ff' }
  }
})

const malicious = {
  'path-traversal.swoblens': zip([{ name: '../theme.json', data: '{}' }, ...validThemeEntries]),
  'javascript-entry.swoblens': zip([...validThemeEntries, { name: 'payload.js', data: 'globalThis.pwned = true' }]),
  'bad-schema.swoblens': zip(packageEntries({
    id: 'fixture.bad-schema',
    name: { 'zh-CN': '坏结构', en: 'Bad schema' },
    type: 'theme',
    declarationName: 'theme.json',
    declaration: { schemaVersion: 1, label: { 'zh-CN': '坏结构', en: 'Bad schema' }, mode: 'both', tokens: { base: '#111111', surface: '#222222', primary: '#eeeeee', accent: '#8888ff' } },
    extraManifest: { entry: 'payload.js' }
  })),
  'compression-bomb.swoblens': zip([{ name: 'manifest.json', data: 'x', declaredCompressedSize: 1, declaredUncompressedSize: 100_000 }]),
  'symlink-entry.swoblens': zip([{ name: 'link', data: 'theme.json', externalAttributes: 0o120777 << 16 }, ...validThemeEntries]),
  'unix-link-metadata.swoblens': zip([{ name: 'link', data: 'theme.json', extra: Buffer.from([0x0d, 0x00, 0x00, 0x00]) }, ...validThemeEntries]),
  'css-network.swoblens': zip(packageEntries({
    id: 'fixture.css-network',
    name: { 'zh-CN': '网络样式', en: 'Network CSS' },
    type: 'theme',
    declarationName: 'theme.json',
    declaration: { schemaVersion: 1, label: { 'zh-CN': '网络样式', en: 'Network CSS' }, mode: 'both', tokens: { base: 'url(https://example.com/a.png)', surface: '#222222', primary: '#eeeeee', accent: '#8888ff' } }
  }))
}

const malformed = zip(validThemeEntries)
const centralOffset = malformed.readUInt32LE(malformed.length - 6)
malformed.writeUInt32LE(0xdeadbeef, centralOffset)
malicious['malformed-central-directory.swoblens'] = malformed

function writeOrCheck(filePath, contents) {
  if (check) {
    if (!fs.existsSync(filePath) || !fs.readFileSync(filePath).equals(contents)) {
      console.error(`Outdated generated file: ${path.relative(root, filePath)}`)
      process.exitCode = 1
    }
    return
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, contents)
}

const sums = []
for (const [name, entries] of Object.entries(samples)) {
  const contents = zip(entries)
  writeOrCheck(path.join(examplesDir, name), contents)
  sums.push(`${sha256(contents)}  ${name}`)
}
writeOrCheck(path.join(examplesDir, 'SHA256SUMS'), Buffer.from(`${sums.sort().join('\n')}\n`))
for (const [name, contents] of Object.entries(malicious)) writeOrCheck(path.join(maliciousDir, name), contents)

if (process.exitCode !== 1) console.log(check ? 'Generated .swoblens fixtures are current.' : 'Generated .swoblens examples and malicious fixtures.')
