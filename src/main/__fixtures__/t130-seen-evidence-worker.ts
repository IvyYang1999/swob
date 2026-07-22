import { ensureSessionInLibrary, initLibrary, scanLibrary } from '../library-manager'

const [mode, libraryRoot, sourcePath, sessionId] = process.argv.slice(2)

async function main(): Promise<void> {
  initLibrary(libraryRoot)
  scanLibrary()
  if (mode === 'scan') return
  await ensureSessionInLibrary({
    id: sessionId,
    sessionId,
    source: 'claude-code',
    filePath: sourcePath,
    allFilePaths: [sourcePath],
    firstUserMessage: 'legacy seen evidence',
    createdAt: '2026-07-22T00:00:00.000Z',
    updatedAt: '2026-07-22T00:01:00.000Z',
    projectPath: '/fixture/project',
    cwds: ['/fixture/project'],
    turnCount: 1
  } as any)
}

main().catch((error) => {
  process.stderr.write(`${(error as Error).name}:${(error as Error).message}\n`)
  process.exitCode = 1
})
