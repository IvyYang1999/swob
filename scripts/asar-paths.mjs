import path from 'node:path'

export function nativeAsarLookupPath(canonicalPath, separator = path.sep) {
  return canonicalPath
    .replace(/^\/+/, '')
    .split('/')
    .filter(Boolean)
    .join(separator)
}
