import * as fs from 'node:fs'
import {
  initLibrary,
  moveSessionToFolder,
  scanLibrary,
  withLibraryMaintenanceWriter
} from '../library-manager'

const [mode, libraryRoot, signalPath] = process.argv.slice(2)

async function main(): Promise<void> {
  initLibrary(libraryRoot)
  scanLibrary()
  if (mode === 'hold') {
    await withLibraryMaintenanceWriter(async () => {
      fs.writeFileSync(`${signalPath}.ready`, process.env.SWOB_TEST_USER_DATA || 'unknown')
      while (!fs.existsSync(`${signalPath}.release`)) {
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
    })
    return
  }
  if (mode === 'move') {
    moveSessionToFolder('session-a', '目标')
    return
  }
  throw new Error(`unknown mode: ${mode}`)
}

main().catch((error) => {
  const typed = error as Error & { code?: string }
  process.stderr.write(`${typed.name}:${typed.code || 'NO_CODE'}:${typed.message}\n`)
  process.exitCode = 1
})
