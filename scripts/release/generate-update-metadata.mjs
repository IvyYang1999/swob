#!/usr/bin/env node

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseSemver } from './assert-release-version.mjs'

const CHANNEL_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export function sha512Base64(fileName) {
  const hash = crypto.createHash('sha512')
  hash.update(fs.readFileSync(fileName))
  return hash.digest('base64')
}

export function buildUpdateMetadata({ releaseDir, version, channel, releaseDate = new Date().toISOString() }) {
  parseSemver(version)
  if (!CHANNEL_PATTERN.test(channel)) throw new Error(`Invalid update channel: ${channel}`)

  const files = ['arm64', 'x64'].map((arch) => {
    const url = `swob-${version}-${arch}.zip`
    const fileName = path.join(releaseDir, url)
    if (!fs.statSync(fileName, { throwIfNoEntry: false })?.isFile()) {
      throw new Error(`Missing update ZIP: ${url}`)
    }
    return {
      url,
      sha512: sha512Base64(fileName),
      size: fs.statSync(fileName).size
    }
  })

  const primary = files[0]
  const lines = [
    `version: ${version}`,
    'files:',
    ...files.flatMap((file) => [
      `  - url: ${file.url}`,
      `    sha512: ${file.sha512}`,
      `    size: ${file.size}`
    ]),
    `path: ${primary.url}`,
    `sha512: ${primary.sha512}`,
    `releaseDate: '${releaseDate}'`,
    ''
  ]

  return { fileName: `${channel}-mac.yml`, files, content: lines.join('\n') }
}

export function writeUpdateMetadata(options) {
  const metadata = buildUpdateMetadata(options)
  const output = options.output
    ? path.resolve(options.output)
    : path.join(options.releaseDir, metadata.fileName)
  fs.writeFileSync(output, metadata.content, { encoding: 'utf8', mode: 0o644 })
  return { ...metadata, output }
}

function readOption(name, fallback = null) {
  const index = process.argv.indexOf(name)
  return index === -1 ? fallback : process.argv[index + 1]
}

async function main() {
  const releaseDir = path.resolve(readOption('--dir', 'dist'))
  const version = readOption('--version')
  const channel = readOption('--channel', 'swob-signed')
  const output = readOption('--output')
  const result = writeUpdateMetadata({ releaseDir, version, channel, output })
  process.stdout.write(`Generated ${result.output} from ${result.files.length} signed update ZIPs\n`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
