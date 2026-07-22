import * as path from 'node:path'

export function normalizePortablePath(value: string): string {
  return value.replace(/\\/g, '/')
}

export function hasPortablePathSegment(value: string, segment: string): boolean {
  const wanted = segment.toLocaleLowerCase()
  return normalizePortablePath(value)
    .split('/')
    .filter(Boolean)
    .some((part) => part.toLocaleLowerCase() === wanted)
}

export function isPortableAbsolutePath(value: string): boolean {
  return path.posix.isAbsolute(value) || path.win32.isAbsolute(value)
}
