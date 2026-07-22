import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as chokidar from 'chokidar'

const mode = process.argv[2]
if (mode !== 'chokidar' && mode !== 'native' && mode !== 'fsevents') {
  throw new Error('usage: node t116-watcher-fd-probe.mjs <chokidar|native|fsevents>')
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-t116-watcher-'))
for (let directoryIndex = 0; directoryIndex < 100; directoryIndex += 1) {
  const directory = path.join(root, `group-${directoryIndex}`)
  fs.mkdirSync(directory)
  for (let fileIndex = 0; fileIndex < 20; fileIndex += 1) {
    fs.writeFileSync(path.join(directory, `session-${fileIndex}.md`), '')
  }
}

const fdCount = () => fs.readdirSync('/dev/fd').length
let watcher
const startedAt = Date.now()

try {
  if (mode === 'chokidar') {
    watcher = chokidar.watch(root, { ignoreInitial: true, depth: 6 })
    await new Promise((resolve, reject) => {
      watcher.once('ready', resolve)
      watcher.once('error', reject)
    })
  } else if (mode === 'native') {
    watcher = fs.watch(root, { recursive: true }, () => {})
    await new Promise((resolve) => setTimeout(resolve, 100))
  } else {
    const fsevents = await import('fsevents')
    const stop = fsevents.watch(root, () => {})
    watcher = { close: stop }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }

  const readyMs = Date.now() - startedAt
  const openFds = fdCount()
  const closeStartedAt = Date.now()
  await watcher.close()
  const closeMs = Date.now() - closeStartedAt
  await new Promise((resolve) => setTimeout(resolve, 100))
  console.log(JSON.stringify({ mode, paths: 2101, readyMs, openFds, closeMs, afterCloseFds: fdCount() }))
} finally {
  try { await watcher?.close() } catch { /* already closed */ }
  fs.rmSync(root, { recursive: true, force: true })
}
