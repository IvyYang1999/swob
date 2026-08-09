import * as fs from 'node:fs'
import { globalPaths } from 'node:module'
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

export function assertAllowedGlobalModulePaths(allowedNodeModulesPath, effectiveGlobalPaths = globalPaths) {
  const allowedLexicalPath = path.resolve(allowedNodeModulesPath)
  const allowedPhysicalPath = fs.realpathSync(allowedLexicalPath)
  const nodePathEntries = (process.env.NODE_PATH ?? '')
    .split(path.delimiter)
    .filter(Boolean)
  const nodePathPhysicalEntries = nodePathEntries.map((entry) => fs.realpathSync(path.resolve(entry)))

  if (nodePathEntries.length !== 1 || nodePathPhysicalEntries[0] !== allowedPhysicalPath) {
    throw new Error(`NODE_PATH must contain only the packaged node_modules directory: ${allowedLexicalPath}`)
  }

  const existingGlobalPaths = effectiveGlobalPaths
    .filter((candidate) => fs.existsSync(candidate))
    .map((candidate) => ({ candidate, physical: fs.realpathSync(candidate) }))
  const unexpected = existingGlobalPaths.filter(({ physical }) => physical !== allowedPhysicalPath)
  if (unexpected.length > 0) {
    throw new Error(
      `Packaged CLI probe has ambient global module paths: ${unexpected
        .map(({ candidate, physical }) => `${candidate} -> ${physical}`)
        .join(', ')}`
    )
  }
  if (!existingGlobalPaths.some(({ physical }) => physical === allowedPhysicalPath)) {
    throw new Error(`Packaged node_modules is absent from the effective global module paths: ${allowedLexicalPath}`)
  }
}

export function assertPackagedCliIsolation(filePath, allowedNodeModulesPath) {
  if (process.env.NODE_OPTIONS) {
    throw new Error('NODE_OPTIONS must be empty while verifying the packaged CLI')
  }
  assertNoAncestorNodeModules(filePath)
  assertAllowedGlobalModulePaths(allowedNodeModulesPath)
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : ''
const invokedDirectly = invokedPath && fs.realpathSync(invokedPath) === fileURLToPath(import.meta.url)
if (invokedDirectly) {
  const filePath = process.argv[2]
  const allowedNodeModulesPath = process.argv[3]
  if (!filePath || !allowedNodeModulesPath) {
    process.stderr.write(
      'Usage: node packaged-cli-isolation.mjs <packaged-cli-entry> <packaged-node-modules>\n'
    )
    process.exitCode = 2
  } else {
    assertPackagedCliIsolation(filePath, allowedNodeModulesPath)
  }
}
