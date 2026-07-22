export function productionPackagePaths(lock) {
  const packages = lock.packages ?? {}
  const roots = new Set()
  const queue = []

  function resolveDependency(fromPackagePath, dependencyName) {
    let current = fromPackagePath
    while (true) {
      const candidate = current
        ? `${current}/node_modules/${dependencyName}`
        : `node_modules/${dependencyName}`
      if (packages[candidate]) return candidate
      if (!current) return null
      const nestedIndex = current.lastIndexOf('/node_modules/')
      current = nestedIndex >= 0 ? current.slice(0, nestedIndex) : ''
    }
  }

  function enqueueDependencies(fromPackagePath, metadata) {
    const names = new Set([
      ...Object.keys(metadata.dependencies ?? {}),
      ...Object.keys(metadata.optionalDependencies ?? {}),
    ])
    for (const name of names) {
      const resolved = resolveDependency(fromPackagePath, name)
      if (resolved && !roots.has(resolved)) queue.push(resolved)
    }
  }

  enqueueDependencies('', packages[''] ?? {})
  while (queue.length > 0) {
    const packagePath = queue.shift()
    if (roots.has(packagePath)) continue
    roots.add(packagePath)
    enqueueDependencies(packagePath, packages[packagePath] ?? {})
  }
  return roots
}

export function packageNameFromLockPath(packagePath, metadata = {}) {
  if (metadata.name) return metadata.name
  return packagePath.split('node_modules/').filter(Boolean).at(-1)
}
