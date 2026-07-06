#!/usr/bin/env node

const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')

const root = path.resolve(__dirname, '..')
const cliPath = path.join(root, 'out', 'main', 'cli.js')

if (!fs.existsSync(cliPath)) {
  process.stderr.write('Built CLI not found. Run `npm run build` before rebuilding transcripts.\n')
  process.exit(1)
}

const args = ['transcript', 'rebuild', '--all', ...process.argv.slice(2)]
const result = spawnSync(process.execPath, [cliPath, ...args], { stdio: 'inherit' })

process.exit(result.status === null ? 1 : result.status)
