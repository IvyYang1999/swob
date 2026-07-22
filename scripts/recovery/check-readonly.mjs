import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const files = [
  path.resolve('src/main/duplicate-recovery-planner.ts'),
  ...fs.readdirSync(path.resolve('scripts/recovery'))
    .filter((name) => /\.(?:mjs|ts)$/.test(name) && name !== 'check-readonly.mjs')
    .map((name) => path.resolve('scripts/recovery', name))
]
const forbidden = [
  /\bfs(?:\.promises)?\.(?:writeFile|appendFile|rename|rm|unlink|copyFile|mkdir|rmdir|symlink|link|truncate)(?:Sync)?\b/,
  /import\s*{[^}]*(?:writeFile|appendFile|rename|rm|unlink|copyFile|mkdir|rmdir|symlink|link|truncate)(?:Sync)?[^}]*}\s*from\s*['"](?:node:)?fs['"]/s,
  /from ['"].*(?:library-manager|vault-organizer)['"]/
]
const violations = []
for (const filePath of files) {
  const source = fs.readFileSync(filePath, 'utf-8')
  for (const pattern of forbidden) {
    if (pattern.test(source)) violations.push(`${path.relative(process.cwd(), filePath)} matches ${pattern}`)
  }
}
if (violations.length > 0) {
  process.stderr.write(`Recovery planner read-only gate failed:\n${violations.map((item) => `- ${item}`).join('\n')}\n`)
  process.exit(1)
}
process.stdout.write('Recovery planner read-only gate passed.\n')
