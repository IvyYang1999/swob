#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const sourcePath = path.join(repoRoot, 'build/brand/swob-logo-session-galaxy.png')
const manifestPath = path.join(repoRoot, 'build/brand/icon-manifest.json')
const checkOnly = process.argv.includes('--check')
const masterSize = 1024

const iconsetEntries = [
  ['icon_16x16.png', 16],
  ['icon_16x16@2x.png', 32],
  ['icon_32x32.png', 32],
  ['icon_32x32@2x.png', 64],
  ['icon_128x128.png', 128],
  ['icon_128x128@2x.png', 256],
  ['icon_256x256.png', 256],
  ['icon_256x256@2x.png', 512],
  ['icon_512x512.png', 512],
  ['icon_512x512@2x.png', 1024]
]

const icoSizes = [16, 24, 32, 48, 64, 128, 256]

function relative(filePath) {
  return toManifestPath(path.relative(repoRoot, filePath))
}

export function toManifestPath(filePath) {
  return filePath.replaceAll('\\', '/')
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

async function assertApprovedManifest(outputs) {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  if (manifest.schemaVersion !== 1 || manifest.source?.path !== relative(sourcePath)) {
    throw new Error('Unsupported or inconsistent brand icon manifest')
  }

  const sourceHash = sha256(await readFile(sourcePath))
  if (sourceHash !== manifest.source.sha256) {
    throw new Error(`Brand source hash is not owner-approved: expected ${manifest.source.sha256}, got ${sourceHash}`)
  }

  const expectedPaths = Object.keys(manifest.outputs ?? {}).sort()
  const generatedPaths = [...outputs.keys()].map(relative).sort()
  if (JSON.stringify(expectedPaths) !== JSON.stringify(generatedPaths)) {
    throw new Error('Brand icon manifest output paths do not match the generator contract')
  }
  for (const [filePath, contents] of outputs) {
    const outputPath = relative(filePath)
    const outputHash = sha256(contents)
    if (outputHash !== manifest.outputs[outputPath]) {
      throw new Error(`Generated icon hash is not approved for ${outputPath}: expected ${manifest.outputs[outputPath]}, got ${outputHash}`)
    }
  }
}

async function assertSource() {
  const metadata = await sharp(sourcePath).metadata()
  if (
    metadata.format !== 'png' ||
    metadata.width !== masterSize ||
    metadata.height !== masterSize ||
    !metadata.hasAlpha
  ) {
    throw new Error(
      `Brand source must be an alpha-enabled ${masterSize}×${masterSize} PNG; got ${JSON.stringify({
        format: metadata.format,
        width: metadata.width,
        height: metadata.height,
        hasAlpha: metadata.hasAlpha
      })}`
    )
  }

  const bounds = await alphaBounds()
  const margins = [
    bounds.minX,
    bounds.minY,
    metadata.width - 1 - bounds.maxX,
    metadata.height - 1 - bounds.maxY
  ]
  const minimumMargin = Math.floor(metadata.width * 0.08)
  const maximumMargin = Math.ceil(metadata.width * 0.12)
  if (margins.some((margin) => margin < minimumMargin || margin > maximumMargin)) {
    throw new Error(
      `Brand source must preserve an 8–12% Apple-style optical margin; got ${margins.join(', ')}px`
    )
  }
}

async function alphaBounds() {
  const { data, info } = await sharp(sourcePath).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  let minX = info.width
  let minY = info.height
  let maxX = -1
  let maxY = -1

  for (let y = 0; y < info.height; y += 1) {
    for (let x = 0; x < info.width; x += 1) {
      const alpha = data[(y * info.width + x) * 4 + 3]
      if (alpha <= 4) continue
      minX = Math.min(minX, x)
      minY = Math.min(minY, y)
      maxX = Math.max(maxX, x)
      maxY = Math.max(maxY, y)
    }
  }

  if (maxX < minX || maxY < minY) throw new Error('Brand source has no visible pixels')
  return { minX, minY, maxX, maxY, width: maxX - minX + 1, height: maxY - minY + 1 }
}

async function renderMaster() {
  // The owner-designated formal export already contains its final Big Sur
  // silhouette and optical margin. Preserve it byte-for-byte as build/icon.png.
  return readFile(sourcePath)
}

async function resizePng(master, size) {
  return sharp(master)
    .resize(size, size, { fit: 'contain', kernel: sharp.kernel.lanczos3 })
    .png({ compressionLevel: 9 })
    .toBuffer()
}

function encodeIco(images) {
  const headerSize = 6 + images.length * 16
  const output = Buffer.alloc(headerSize + images.reduce((sum, image) => sum + image.buffer.length, 0))
  output.writeUInt16LE(0, 0)
  output.writeUInt16LE(1, 2)
  output.writeUInt16LE(images.length, 4)

  let dataOffset = headerSize
  images.forEach(({ size, buffer }, index) => {
    const entryOffset = 6 + index * 16
    output.writeUInt8(size === 256 ? 0 : size, entryOffset)
    output.writeUInt8(size === 256 ? 0 : size, entryOffset + 1)
    output.writeUInt8(0, entryOffset + 2)
    output.writeUInt8(0, entryOffset + 3)
    output.writeUInt16LE(1, entryOffset + 4)
    output.writeUInt16LE(32, entryOffset + 6)
    output.writeUInt32LE(buffer.length, entryOffset + 8)
    output.writeUInt32LE(dataOffset, entryOffset + 12)
    buffer.copy(output, dataOffset)
    dataOffset += buffer.length
  })

  return output
}

function encodeIcns(resized) {
  // Modern ICNS accepts PNG payloads for every represented size. Encoding the
  // container directly keeps the pipeline deterministic and cross-platform.
  const chunks = [
    ['icp4', resized.get(16)],
    ['icp5', resized.get(32)],
    ['icp6', resized.get(64)],
    ['ic07', resized.get(128)],
    ['ic08', resized.get(256)],
    ['ic09', resized.get(512)],
    ['ic10', resized.get(1024)]
  ]
  const totalSize = 8 + chunks.reduce((sum, [, buffer]) => sum + 8 + buffer.length, 0)
  const output = Buffer.alloc(totalSize)
  output.write('icns', 0, 4, 'ascii')
  output.writeUInt32BE(totalSize, 4)
  let offset = 8
  for (const [type, buffer] of chunks) {
    output.write(type, offset, 4, 'ascii')
    output.writeUInt32BE(buffer.length + 8, offset + 4)
    buffer.copy(output, offset + 8)
    offset += buffer.length + 8
  }
  return output
}

function svgWrapper(png128) {
  return Buffer.from(
    [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512" role="img" aria-label="Swob">',
      `  <image width="512" height="512" href="data:image/png;base64,${png128.toString('base64')}"/>`,
      '</svg>',
      ''
    ].join('\n')
  )
}

async function buildOutputs() {
  await assertSource()
  const master = await renderMaster()
  const uniqueSizes = [...new Set([...iconsetEntries.map(([, size]) => size), ...icoSizes, 180])]
  const resized = new Map(await Promise.all(uniqueSizes.map(async (size) => [size, await resizePng(master, size)])))
  const icns = encodeIcns(resized)
  const ico = encodeIco(icoSizes.map((size) => ({ size, buffer: resized.get(size) })))
  const faviconSvg = svgWrapper(resized.get(128))

  const outputs = new Map([
    [path.join(repoRoot, 'build/icon.png'), master],
    [path.join(repoRoot, 'build/icon.icns'), icns],
    [path.join(repoRoot, 'build/icon.ico'), ico]
  ])

  const siteAssets = path.join(repoRoot, 'site/assets')
  outputs.set(path.join(siteAssets, 'favicon-32.png'), resized.get(32))
  outputs.set(path.join(siteAssets, 'apple-touch-icon.png'), resized.get(180))
  outputs.set(path.join(siteAssets, 'favicon-512.png'), resized.get(512))
  outputs.set(path.join(siteAssets, 'favicon.svg'), faviconSvg)

  return outputs
}

async function writeIfChanged(filePath, contents) {
  const existing = await readFile(filePath).catch(() => null)
  if (existing?.equals(contents)) return false
  await mkdir(path.dirname(filePath), { recursive: true })
  await writeFile(filePath, contents)
  return true
}

async function main() {
  const outputs = await buildOutputs()
  await assertApprovedManifest(outputs)
  if (checkOnly) {
    const stale = []
    for (const [filePath, expected] of outputs) {
      const actual = await readFile(filePath).catch(() => null)
      if (!actual?.equals(expected)) stale.push(relative(filePath))
    }
    if (stale.length > 0) {
      throw new Error(`Generated icon assets are missing or stale:\n${stale.map((file) => `- ${file}`).join('\n')}`)
    }
    console.log(`Icon assets are current (${outputs.size} files).`)
    return
  }

  const changed = []
  for (const [filePath, contents] of outputs) {
    if (await writeIfChanged(filePath, contents)) changed.push(relative(filePath))
  }
  console.log(changed.length > 0 ? `Updated ${changed.length} icon assets:\n${changed.join('\n')}` : 'Icon assets already current.')
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
}
