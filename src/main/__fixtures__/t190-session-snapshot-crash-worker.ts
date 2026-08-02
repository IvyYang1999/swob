import * as fs from 'node:fs'
import * as path from 'node:path'
import { createHash } from 'node:crypto'
import {
  initLibrary,
  scanLibrary,
  syncBackup,
  updateTranscript
} from '../library-manager'

const [mode, libraryRoot, sessionDir, evidencePath] = process.argv.slice(2)

function sha256(content: Buffer | string): string {
  return createHash('sha256').update(content).digest('hex')
}

async function runProductionPipeline(sessionId: string): Promise<void> {
  await updateTranscript(sessionId, undefined, sessionDir)
  await syncBackup(sessionId, sessionDir)
}

async function main(): Promise<void> {
  initLibrary(libraryRoot)
  scanLibrary()
  const initialMeta = JSON.parse(fs.readFileSync(path.join(sessionDir, '.swob-session.json'), 'utf8')) as {
    sessionId: string
    sourceFilePaths: string[]
  }
  await runProductionPipeline(initialMeta.sessionId)

  if (mode === 'crash') throw new Error('configured SIGKILL stage was not reached')
  if (mode !== 'recover-verify') throw new Error(`unknown mode: ${mode}`)

  const transcriptPath = path.join(sessionDir, 'transcript.md')
  const backupPath = path.join(sessionDir, 'backup.jsonl')
  const manifestPath = path.join(sessionDir, '.swob-session.json')
  const transcript = fs.readFileSync(transcriptPath, 'utf8')
  const backup = fs.readFileSync(backupPath)
  const manifestBytes = fs.readFileSync(manifestPath)
  const manifest = JSON.parse(manifestBytes.toString('utf8')) as {
    turnCount?: number
    backupSha256?: string
    backupSize?: number
    sourceFilePaths: string[]
  }
  const source = fs.readFileSync(manifest.sourceFilePaths[0])
  const transcriptTurns = Number(/^turns:\s*(\d+)$/m.exec(transcript)?.[1] || -1)
  const backupHash = sha256(backup)

  if (!backup.equals(source) || manifest.backupSha256 !== backupHash || manifest.backupSize !== backup.length ||
    manifest.turnCount !== 2 || transcriptTurns !== 2 || !transcript.includes('second user turn') ||
    fs.existsSync(path.join(sessionDir, '.swob-write-transaction.json')) ||
    fs.existsSync(path.join(sessionDir, '.swob-write-snapshots'))) {
    throw new Error(`recovered production session package is inconsistent: ${JSON.stringify({
      backupEqualsSource: backup.equals(source),
      manifestBackupSha256: manifest.backupSha256,
      backupHash,
      manifestBackupSize: manifest.backupSize,
      backupSize: backup.length,
      manifestTurnCount: manifest.turnCount,
      transcriptTurns,
      hasLatestTurn: transcript.includes('second user turn'),
      markerExists: fs.existsSync(path.join(sessionDir, '.swob-write-transaction.json')),
      snapshotExists: fs.existsSync(path.join(sessionDir, '.swob-write-snapshots'))
    })}`)
  }

  fs.writeFileSync(evidencePath, JSON.stringify({
    transcriptSha256: sha256(transcript),
    backupSha256: backupHash,
    manifestSha256: sha256(manifestBytes),
    sourceSha256: sha256(source),
    manifestBackupSha256: manifest.backupSha256,
    turnCount: manifest.turnCount,
    transcriptTurns
  }))
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`)
  process.exitCode = 1
})
