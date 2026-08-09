import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

function collectAncestorNodeModules(filePath) {
  const lexicalPath = path.resolve(filePath)
  const physicalPath = fs.realpathSync(lexicalPath)
  const candidates = new Set()

  for (const resolvedPath of [lexicalPath, physicalPath]) {
    let current = path.dirname(resolvedPath)
    for (;;) {
      candidates.add(path.join(current, 'node_modules'))
      const parent = path.dirname(current)
      if (parent === current) break
      current = parent
    }
  }

  return [...candidates]
}

export function assertNoAncestorNodeModules(filePath) {
  const ambient = collectAncestorNodeModules(filePath).filter((candidate) => fs.existsSync(candidate))
  if (ambient.length > 0) {
    throw new Error(`Packaged CLI probe has ambient node_modules ancestors: ${ambient.join(', ')}`)
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : ''
const invokedDirectly = invokedPath && fs.realpathSync(invokedPath) === fileURLToPath(import.meta.url)
if (invokedDirectly) {
  const filePath = process.argv[2]
  if (!filePath) {
    process.stderr.write('Usage: node packaged-cli-isolation.mjs <packaged-cli-entry>\n')
    process.exitCode = 2
  } else {
    assertNoAncestorNodeModules(filePath)
  }
}
