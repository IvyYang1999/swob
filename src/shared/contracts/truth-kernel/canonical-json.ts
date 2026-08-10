import { createHash } from 'node:crypto'

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalize(child)])
    )
  }
  return value
}

export function truthKernelCanonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value))
}

export function truthKernelCanonicalSha256(value: unknown): string {
  return createHash('sha256').update(truthKernelCanonicalJson(value), 'utf8').digest('hex')
}

export function truthKernelRoundTrip<T>(value: T): T {
  return JSON.parse(truthKernelCanonicalJson(value)) as T
}
