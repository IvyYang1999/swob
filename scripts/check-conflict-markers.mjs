import { execFileSync } from 'node:child_process'

try {
  const matches = execFileSync('git', ['grep', '-n', '^<<<<<<< '], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  })
  process.stderr.write('Unresolved merge conflict markers found:\n')
  process.stderr.write(matches)
  process.exitCode = 1
} catch (error) {
  if (error && typeof error === 'object' && error.status === 1) {
    process.exitCode = 0
  } else {
    throw error
  }
}
