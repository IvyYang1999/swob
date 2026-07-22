import { ensureSessionInLibrary, initLibrary, scanLibrary } from '../library-manager'

const [libraryRoot, sourcePath, sessionId] = process.argv.slice(2)

async function main(): Promise<void> {
  process.stdout.write(`${process.pid}\n`)
  initLibrary(libraryRoot)
  scanLibrary()
  await ensureSessionInLibrary({
    id: sessionId,
    sessionId,
    source: 'claude-code',
    filePath: sourcePath,
    allFilePaths: [sourcePath],
    firstUserMessage: 't130 concurrent package',
    createdAt: '2026-07-22T00:00:00.000Z',
    updatedAt: '2026-07-22T00:01:00.000Z',
    projectPath: '/fixture/project',
    cwds: ['/fixture/project'],
    turnCount: 1
  } as any)
}

main().catch((error) => {
  const issueKinds = (error as { issueKinds?: unknown }).issueKinds
  process.stderr.write(`${(error as Error).name}:${(error as Error).message}:${JSON.stringify(issueKinds || null)}\n`)
  process.exitCode = 1
})
