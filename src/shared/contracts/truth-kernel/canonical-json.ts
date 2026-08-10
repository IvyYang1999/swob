import { createHash } from 'node:crypto'

function canonicalize(value: unknown, ancestors: Set<object>): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('truth-kernel-canonical-json:non-finite-number')
    return Object.is(value, -0) ? 0 : value
  }
  if (typeof value === 'undefined' || typeof value === 'bigint' || typeof value === 'function' || typeof value === 'symbol') {
    throw new TypeError(`truth-kernel-canonical-json:unsupported-${typeof value}`)
  }
  if (typeof value !== 'object') throw new TypeError('truth-kernel-canonical-json:unsupported-value')
  if (ancestors.has(value)) throw new TypeError('truth-kernel-canonical-json:cyclic-value')
  ancestors.add(value)
  try {
    if (Array.isArray(value)) return value.map((entry) => canonicalize(entry, ancestors))
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError('truth-kernel-canonical-json:non-plain-object')
    }
    // A null prototype keeps every legal JSON key as data. In particular,
    // assigning `__proto__` to a normal object would invoke its legacy setter
    // and silently drop that own property from the canonical output.
    const result = Object.create(null) as Record<string, unknown>
    // Default string comparison is a locale-independent UTF-16 code-unit order.
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      result[key] = canonicalize((value as Record<string, unknown>)[key], ancestors)
    }
    return result
  } finally {
    ancestors.delete(value)
  }
}

export function truthKernelCanonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value, new Set()))
}

/** Exact exported JSON bytes: UTF-8 canonical JSON with no BOM, newline, or trailing byte. */
export function truthKernelCanonicalUtf8Bytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(truthKernelCanonicalJson(value))
}

export function truthKernelRawSha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

export function truthKernelCanonicalSha256(value: unknown): string {
  return truthKernelRawSha256(truthKernelCanonicalUtf8Bytes(value))
}

export function truthKernelRoundTrip<T>(value: T): T {
  return JSON.parse(truthKernelCanonicalJson(value)) as T
}

export interface TruthKernelChainHashInput {
  sourceIngestReceiptId: string
  parserId: string
  parserVersion: string
  serializationVersion: string
  sequence: number
  previousChainHash: string | null
  eventDigest: string
}

export function truthKernelRollingChainHash(input: TruthKernelChainHashInput): string {
  return truthKernelCanonicalSha256({ domain: 'swob.truth-kernel.chain-entry.v1', ...input })
}

export function truthKernelBundleManifestDigest(manifest: object & { bundleDigest?: string }): string {
  const { bundleDigest: _excluded, ...digestInput } = manifest
  return truthKernelCanonicalSha256({ domain: 'swob.truth-kernel.verify-bundle-manifest.v1', manifest: digestInput })
}
