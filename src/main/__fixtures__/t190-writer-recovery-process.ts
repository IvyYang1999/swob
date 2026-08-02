import * as fs from 'node:fs'
import * as path from 'node:path'
import { acquireLibraryWriterLease, LibraryWriterBusyError } from '../library-writer-lease'

const [mode, libraryRoot, controlPrefix, contenderId = 'worker'] = process.argv.slice(2)
let controlPublishSequence = 0

function sleepSync(milliseconds: number): void {
  const signal = new Int32Array(new SharedArrayBuffer(4))
  Atomics.wait(signal, 0, 0, milliseconds)
}

function waitForFileSync(filePath: string): void {
  const deadline = Date.now() + 10_000
  while (!fs.existsSync(filePath)) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${filePath}`)
    sleepSync(5)
  }
}

async function waitForFile(filePath: string): Promise<void> {
  const deadline = Date.now() + 10_000
  while (!fs.existsSync(filePath)) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${filePath}`)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

function syncParentDirectory(filePath: string): void {
  let directory: number | undefined
  try {
    directory = fs.openSync(path.dirname(filePath), 'r')
    fs.fsyncSync(directory)
  } catch {
    // Directory fsync is unavailable on some platforms. The fully-written inode is
    // still published atomically by linkSync; this sync only strengthens durability.
  } finally {
    if (directory !== undefined) fs.closeSync(directory)
  }
}

function writeOnce(filePath: string, content: string): void {
  const tempPath = `${filePath}.publish-${process.pid}-${++controlPublishSequence}.tmp`
  let descriptor: number | undefined
  try {
    descriptor = fs.openSync(tempPath, 'wx', 0o600)
    fs.writeFileSync(descriptor, content, 'utf8')
    fs.fsyncSync(descriptor)
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor)
  }

  try {
    // linkSync is an atomic no-replace publish: unlike open('wx') + write, readers
    // can never observe an empty destination; unlike rename, a later contender
    // cannot overwrite the first claimant's signal.
    fs.linkSync(tempPath, filePath)
    syncParentDirectory(filePath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  } finally {
    try { fs.unlinkSync(tempPath) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
}

async function main(): Promise<void> {
  if (mode === 'seed') {
    await acquireLibraryWriterLease(libraryRoot, 'seed-profile', 'maintenance', { heartbeatMs: 1_000 })
    writeOnce(`${controlPrefix}.seed-ready`, 'ready')
    await waitForFile(`${controlPrefix}.seed-release`)
    return
  }

  if (mode === 'heartbeat-crash') {
    await acquireLibraryWriterLease(libraryRoot, 'heartbeat-profile', 'maintenance', {
      heartbeatMs: 10,
      heartbeatBeforePublish: () => {
        writeOnce(`${controlPrefix}.heartbeat-temp-ready`, 'ready')
        waitForFileSync(`${controlPrefix}.never-release-heartbeat`)
      }
    })
    writeOnce(`${controlPrefix}.heartbeat-owner-ready`, 'ready')
    await waitForFile(`${controlPrefix}.never-release-owner`)
    return
  }

  if (mode === 'contend') {
    writeOnce(`${controlPrefix}.${contenderId}.ready`, 'ready')
    await waitForFile(`${controlPrefix}.start`)
    try {
      const lease = await acquireLibraryWriterLease(libraryRoot, `contender-${contenderId}`, 'move', {
        timeoutMs: 1_000,
        pollMs: 5,
        recoveryClaimCreated: () => {
          writeOnce(`${controlPrefix}.claim-ready`, contenderId)
          waitForFileSync(`${controlPrefix}.claim-release`)
        },
        recoveryClaimObserved: () => writeOnce(`${controlPrefix}.${contenderId}.claim-observed`, 'observed'),
        eventSink: (event) => {
          if (event.event === 'stale-recovered') {
            writeOnce(`${controlPrefix}.${contenderId}.stale-recovered`, 'recovered')
          }
        }
      })
      writeOnce(`${controlPrefix}.${contenderId}.won`, JSON.stringify(lease.owner))
      await waitForFile(`${controlPrefix}.${contenderId}.release`)
      lease.release()
    } catch (error) {
      if (!(error instanceof LibraryWriterBusyError)) throw error
      writeOnce(`${controlPrefix}.${contenderId}.lost`, error.reason)
    }
    return
  }

  if (mode === 'recover-once') {
    const lease = await acquireLibraryWriterLease(libraryRoot, `recovery-${contenderId}`, 'maintenance', {
      timeoutMs: 2_000,
      pollMs: 5
    })
    writeOnce(`${controlPrefix}.recovered`, JSON.stringify(lease.owner))
    lease.release()
    return
  }

  throw new Error(`unknown mode: ${mode}`)
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`)
  process.exitCode = 1
})
