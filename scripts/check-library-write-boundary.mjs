import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const mainDir = path.resolve('src/main')
const violations = []

for (const name of fs.readdirSync(mainDir)) {
  if (!name.endsWith('.ts') || name.endsWith('.test.ts')) continue
  const filePath = path.join(mainDir, name)
  const source = fs.readFileSync(filePath, 'utf-8')

  if (name !== 'library-manager.ts' && name !== 'vault-organizer.ts' &&
      /from ['"]\.\/library-write-coordinator['"]/.test(source)) {
    violations.push(`${name}: only library-manager and the transactional mover may access the coordinator`)
  }

  if (name !== 'library-manager.ts' && name !== 'vault-organizer.ts' &&
      /\b(executeOrganization|undoLastOrganization|recoverInterruptedOrganization)\b/.test(source)) {
    violations.push(`${name}: raw Library movement mutator bypasses library-manager`)
  }

  if (name !== 'library-manager.ts' &&
      /fs\.(?:mkdirSync|renameSync|rmSync|unlinkSync|writeFileSync)\([^\n]*getLibraryRoot\s*\(/.test(source)) {
    violations.push(`${name}: direct filesystem write is rooted at getLibraryRoot()`)
  }

  const lowLevelWriters = {
    writeDashboardLayout: ['dashboard-layout.ts', 'index.ts'],
    writeSessionLineageRegistry: ['session-lineage.ts', 'index.ts'],
    recordRecoveryAttempt: ['recovery-metrics.ts', 'library-manager.ts']
  }
  for (const [writer, allowedFiles] of Object.entries(lowLevelWriters)) {
    if (source.includes(`${writer}(`) && !allowedFiles.includes(name)) {
      violations.push(`${name}: ${writer} is a low-level Library writer and needs a coordinator entrypoint`)
    }
  }
}

const organizer = fs.readFileSync(path.join(mainDir, 'vault-organizer.ts'), 'utf-8')
for (const functionName of ['executeOrganization', 'undoLastOrganization', 'recoverInterruptedOrganization']) {
  const start = organizer.indexOf(`function ${functionName}`)
  const sample = start < 0 ? '' : organizer.slice(start, start + 500)
  if (!sample.includes('assertLibraryWriterHeld(root)')) {
    violations.push(`vault-organizer.ts: ${functionName} lacks the runtime writer assertion`)
  }
}

const indexSource = fs.readFileSync(path.join(mainDir, 'index.ts'), 'utf-8')
for (const guardedCall of [
  'withLibraryMaintenanceWriter(() => writeDashboardLayout',
  'withLibraryMaintenanceWriter(() => writeSessionLineageRegistry'
]) {
  if (!indexSource.includes(guardedCall)) violations.push(`index.ts: missing coordinator around ${guardedCall}`)
}

const frontendIpc = fs.readFileSync(path.join(mainDir, 'frontend-ipc.ts'), 'utf-8')
if (!frontendIpc.includes('dependencies.withLibraryWriter(() =>')) {
  violations.push('frontend-ipc.ts: managed avatar import lacks its injected Library writer boundary')
}

if (violations.length > 0) {
  console.error('Library write-boundary check failed:\n' + violations.map((item) => `- ${item}`).join('\n'))
  process.exit(1)
}

console.log('Library write-boundary check passed.')
