import * as path from 'node:path'
import { beginSessionWriteSnapshot } from '../library-session-write-snapshot'
import { runWithLibraryWriter } from '../library-write-coordinator'
import { replaceSafeLibraryFileSync } from '../library-path-safety'

const [libraryRoot, sessionDir, crashAfter] = process.argv.slice(2)
const stages = ['transcript.md', 'backup.jsonl', '.swob-session.json'] as const
const newFiles = {
  'transcript.md': '# new transcript\n',
  'backup.jsonl': '{"snapshot":"new"}\n',
  '.swob-session.json': JSON.stringify({
    schemaVersion: 3,
    sessionId: 'old',
    updatedAt: '2026-08-02T00:00:00.000Z'
  })
}

await runWithLibraryWriter(libraryRoot, 'crash-worker-profile', 'maintenance', async () => {
  beginSessionWriteSnapshot(libraryRoot, sessionDir)
  for (const name of stages) {
    replaceSafeLibraryFileSync(libraryRoot, path.join(sessionDir, name), newFiles[name])
    if (name === crashAfter) {
      process.stdout.write(`${name}\n`)
      await new Promise<void>(() => {})
    }
  }
})
