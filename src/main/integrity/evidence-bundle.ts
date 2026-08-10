import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import {
  TRUTH_KERNEL_SERIALIZATION_VERSION,
  truthKernelBundleManifestDigest,
  truthKernelCanonicalUtf8Bytes,
  truthKernelRawSha256,
  truthKernelRollingChainHash,
  type CanonicalEventChain,
  type SourceIngestReceipt,
  type VerificationFailure,
  type VerificationResult,
  type VerifyBundleManifest
} from '../../shared/contracts/truth-kernel'

export interface EvidenceBundleInput {
  bundleId: string
  generatedAt: string
  receipts: SourceIngestReceipt[]
  chains: CanonicalEventChain[]
  events: Array<{ eventId: string; bytes: Uint8Array }>
}

export interface EvidenceBundle { manifest: VerifyBundleManifest; files: Map<string, Uint8Array> }

export const OFFLINE_VERIFIER_SOURCE = String.raw`#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
const root=resolve(process.argv[2]||'.'), enc=new TextEncoder(), dec=new TextDecoder('utf-8',{fatal:true})
const canon=(v,seen=new Set())=>{if(v===null||typeof v==='string'||typeof v==='boolean')return v;if(typeof v==='number'){if(!Number.isFinite(v))throw Error('non-finite');return Object.is(v,-0)?0:v}if(typeof v!=='object'||seen.has(v))throw Error('non-json');seen.add(v);try{if(Array.isArray(v))return v.map(x=>canon(x,seen));const o=Object.create(null);for(const k of Object.keys(v).sort())o[k]=canon(v[k],seen);return o}finally{seen.delete(v)}}
const bytes=v=>enc.encode(JSON.stringify(canon(v))), hash=b=>createHash('sha256').update(b).digest('hex'), hobj=v=>hash(bytes(v))
const manifest=JSON.parse(dec.decode(readFileSync(resolve(root,'manifest.json')))), failures=[]
const fail=(code,path)=>failures.push({code,path})
const digest=(()=>{const {bundleDigest,...rest}=manifest;return hobj({domain:'swob.truth-kernel.verify-bundle-manifest.v1',manifest:rest})})()
if(manifest.serializationVersion!=='truth-kernel-canonical-json/1')fail('serialization-version-unsupported','manifest.json')
if(digest!==manifest.bundleDigest)fail('bundle-artifact-digest-mismatch','manifest.json')
const arts=new Map(), receipts=new Map()
for(const a of manifest.artifacts){if(!a.relativePath||a.relativePath.startsWith('/')||a.relativePath.includes('\\')||a.relativePath.split('/').some(x=>!x||x==='.'||x==='..')){fail('bundle-path-unsafe',a.relativePath);continue}try{const b=readFileSync(resolve(root,a.relativePath));if(b.length!==a.sizeBytes)fail('bundle-truncated',a.relativePath);if(hash(b)!==a.sha256)fail('bundle-artifact-digest-mismatch',a.relativePath);arts.set(a.objectId,{...a,b});if(a.kind==='source-receipt')receipts.set(a.objectId,JSON.parse(dec.decode(b)))}catch{fail('bundle-artifact-missing',a.relativePath)}}
for(const wanted of manifest.sourceReceipts){const r=receipts.get(wanted.receiptId);if(!r||r.sourceSha256!==wanted.sourceSha256)fail('source-digest-mismatch',wanted.receiptId)}
for(const a of manifest.artifacts.filter(x=>x.kind==='event-chain')){const stored=arts.get(a.objectId);if(!stored)continue;const c=JSON.parse(dec.decode(stored.b)), receipt=receipts.get(c.sourceIngestReceiptId);if(c.serializationVersion!=='truth-kernel-canonical-json/1')fail('serialization-version-unsupported',a.relativePath);if(!receipt||receipt.parserId!==c.parserId||receipt.parserVersion!==c.parserVersion||!manifest.parserVersions.some(x=>x.parserId===c.parserId&&x.parserVersion===c.parserVersion))fail('parser-version-mismatch',a.relativePath);if(c.entries.length!==c.expectedEventCount)fail('event-missing',a.relativePath);let previous=null;const seen=new Set();for(let i=0;i<c.entries.length;i++){const e=c.entries[i],ev=arts.get(e.eventId);if(seen.has(e.eventId))fail('event-duplicate',a.relativePath);seen.add(e.eventId);if(e.sequence!==i)fail('event-reordered',a.relativePath);if(!ev){fail('event-missing',e.eventId);continue}if(hash(ev.b)!==e.eventDigest||ev.sha256!==e.eventDigest)fail('event-digest-mismatch',ev.relativePath);const linked=i===0?e.previousChainHash.status!=='available':e.previousChainHash.status==='available'&&e.previousChainHash.value===previous;if(!linked)fail('chain-link-invalid',a.relativePath);const expected=hobj({domain:'swob.truth-kernel.chain-entry.v1',sourceIngestReceiptId:c.sourceIngestReceiptId,parserId:c.parserId,parserVersion:c.parserVersion,serializationVersion:c.serializationVersion,sequence:e.sequence,previousChainHash:previous,eventDigest:e.eventDigest});if(expected!==e.chainHash)fail('chain-link-invalid',a.relativePath);previous=e.chainHash}const head=c.headHash.status==='available'?c.headHash.value:null, declared=manifest.chainHeads.find(x=>x.chainId===c.chainId)?.headHash;if(previous!==head||head!==declared)fail('chain-link-invalid',a.relativePath)}
const result={status:failures.length?'invalid':'valid',failures};process.stdout.write(JSON.stringify(result)+'\n');process.exitCode=failures.length?1:0
`
const OFFLINE_VERIFIER_BYTES = new TextEncoder().encode(OFFLINE_VERIFIER_SOURCE)

function digest(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex') }
function json<T>(bytes: Uint8Array): T { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as T }
function safePath(value: string): boolean {
  return value !== '' && !value.startsWith('/') && !value.includes('\\') && !value.split('/').some((part) => part === '' || part === '.' || part === '..')
}

export function createEvidenceBundle(input: EvidenceBundleInput): EvidenceBundle {
  const files = new Map<string, Uint8Array>()
  const artifacts: VerifyBundleManifest['artifacts'] = []
  const add = (kind: VerifyBundleManifest['artifacts'][number]['kind'], objectId: string, relativePath: string, bytes: Uint8Array, contentEncoding: VerifyBundleManifest['artifacts'][number]['contentEncoding']) => {
    files.set(relativePath, bytes)
    artifacts.push({ kind, objectId, relativePath, contentEncoding, sha256: digest(bytes), sizeBytes: bytes.byteLength })
  }
  for (const receipt of input.receipts) add('source-receipt', receipt.receiptId, `receipts/${receipt.receiptId}.json`, truthKernelCanonicalUtf8Bytes(receipt), 'utf8-canonical-json-no-extra-bytes')
  for (const chain of input.chains) add('event-chain', chain.chainId, `chains/${chain.chainId}.json`, truthKernelCanonicalUtf8Bytes(chain), 'utf8-canonical-json-no-extra-bytes')
  for (const event of input.events) {
    const parsed = json<unknown>(event.bytes)
    const canonical = truthKernelCanonicalUtf8Bytes(parsed)
    if (digest(canonical) !== digest(event.bytes)) throw new Error(`external-evidence:event-not-canonical:${event.eventId}`)
    add('canonical-event', event.eventId, `events/${event.eventId}.json`, event.bytes, 'utf8-canonical-json-no-extra-bytes')
  }
  add('offline-verifier', 'swob-offline-verifier', 'verify/swob-verify.mjs', OFFLINE_VERIFIER_BYTES, 'raw-bytes')
  artifacts.sort((left, right) => left.relativePath.localeCompare(right.relativePath, 'en'))
  const manifest: VerifyBundleManifest = {
    schemaVersion: 1, bundleId: input.bundleId, generatedAt: input.generatedAt,
    sourceReceipts: input.receipts.map((receipt) => ({ receiptId: receipt.receiptId, sourceSha256: receipt.sourceSha256 })),
    chainHeads: input.chains.flatMap((chain) => chain.headHash.status === 'available' ? [{ chainId: chain.chainId, headHash: chain.headHash.value }] : []),
    parserVersions: input.receipts.map((receipt) => ({ parserId: receipt.parserId, parserVersion: receipt.parserVersion })),
    serializationVersion: TRUTH_KERNEL_SERIALIZATION_VERSION, artifacts,
    verifier: { verifierId: 'swob-offline-verifier', version: '1', sha256: digest(OFFLINE_VERIFIER_BYTES) },
    digestAlgorithm: 'sha256-canonical-json-excluding-bundleDigest', bundleDigest: '', claimBoundary: 'integrity-after-ingest'
  }
  manifest.bundleDigest = truthKernelBundleManifestDigest(manifest)
  files.set('manifest.json', truthKernelCanonicalUtf8Bytes(manifest))
  return { manifest, files }
}

function failure(code: VerificationFailure['code'], message: string, artifactPath?: string, expected?: string, actual?: string): VerificationFailure {
  return { code, message,
    artifactPath: artifactPath ? { status: 'available', value: artifactPath } : { status: 'unknown', reason: 'not-applicable' },
    expectedDigest: expected ? { status: 'available', value: expected } : { status: 'unknown', reason: 'not-applicable' },
    actualDigest: actual ? { status: 'available', value: actual } : { status: 'unknown', reason: 'not-applicable' } }
}

/** Verifies only exported bytes. No Swob service, mutable database or caller-supplied object is trusted. */
export function verifyEvidenceBundle(bundle: EvidenceBundle, checkedAt: string): VerificationResult {
  const failures: VerificationFailure[] = []
  const manifestBytes = bundle.files.get('manifest.json')
  let manifest: VerifyBundleManifest
  try { manifest = manifestBytes ? json<VerifyBundleManifest>(manifestBytes) : bundle.manifest } catch {
    manifest = bundle.manifest
    failures.push(failure('bundle-truncated', 'manifest is not valid UTF-8 JSON', 'manifest.json'))
  }
  if (!manifestBytes) failures.push(failure('bundle-artifact-missing', 'manifest missing', 'manifest.json'))
  else if (digest(truthKernelCanonicalUtf8Bytes(manifest)) !== digest(manifestBytes)) failures.push(failure('bundle-artifact-digest-mismatch', 'manifest is not canonical JSON', 'manifest.json'))
  if (manifest.serializationVersion !== TRUTH_KERNEL_SERIALIZATION_VERSION) failures.push(failure('serialization-version-unsupported', 'unsupported bundle serialization version', 'manifest.json'))
  const expectedManifestDigest = truthKernelBundleManifestDigest(manifest)
  if (expectedManifestDigest !== manifest.bundleDigest) failures.push(failure('bundle-artifact-digest-mismatch', 'manifest digest mismatch', 'manifest.json', expectedManifestDigest, manifest.bundleDigest))

  const artifacts = new Map<string, VerifyBundleManifest['artifacts'][number]>()
  for (const artifact of manifest.artifacts) {
    if (!safePath(artifact.relativePath)) { failures.push(failure('bundle-path-unsafe', 'unsafe artifact path', artifact.relativePath)); continue }
    if (artifacts.has(artifact.relativePath)) { failures.push(failure('bundle-path-unsafe', 'duplicate artifact path', artifact.relativePath)); continue }
    artifacts.set(artifact.relativePath, artifact)
    const bytes = bundle.files.get(artifact.relativePath)
    if (!bytes) { failures.push(failure('bundle-artifact-missing', 'artifact missing', artifact.relativePath, artifact.sha256)); continue }
    const actual = truthKernelRawSha256(bytes)
    if (bytes.byteLength !== artifact.sizeBytes) failures.push(failure('bundle-truncated', 'artifact size mismatch', artifact.relativePath, String(artifact.sizeBytes), String(bytes.byteLength)))
    if (actual !== artifact.sha256) failures.push(failure('bundle-artifact-digest-mismatch', 'artifact digest mismatch', artifact.relativePath, artifact.sha256, actual))
    if (artifact.contentEncoding === 'utf8-canonical-json-no-extra-bytes') {
      try { if (digest(truthKernelCanonicalUtf8Bytes(json(bytes))) !== actual) failures.push(failure('bundle-artifact-digest-mismatch', 'canonical artifact serialization mismatch', artifact.relativePath)) }
      catch { failures.push(failure('bundle-truncated', 'canonical artifact is invalid JSON', artifact.relativePath)) }
    }
  }

  const byKind = (kind: VerifyBundleManifest['artifacts'][number]['kind']) => manifest.artifacts.filter((artifact) => artifact.kind === kind)
  const receipts = new Map<string, SourceIngestReceipt>()
  for (const artifact of byKind('source-receipt')) {
    const bytes = bundle.files.get(artifact.relativePath)
    if (!bytes) continue
    try { receipts.set(artifact.objectId, json<SourceIngestReceipt>(bytes)) } catch { /* already reported */ }
  }
  for (const expected of manifest.sourceReceipts) {
    const receipt = receipts.get(expected.receiptId)
    if (!receipt || receipt.receiptId !== expected.receiptId || receipt.sourceSha256 !== expected.sourceSha256) failures.push(failure('source-digest-mismatch', 'source receipt does not match manifest', `receipts/${expected.receiptId}.json`, expected.sourceSha256, receipt?.sourceSha256))
  }

  const eventArtifacts = new Map(byKind('canonical-event').map((artifact) => [artifact.objectId, artifact]))
  for (const artifact of byKind('event-chain')) {
    const bytes = bundle.files.get(artifact.relativePath)
    if (!bytes) continue
    let chain: CanonicalEventChain
    try { chain = json<CanonicalEventChain>(bytes) } catch { continue }
    if (chain.serializationVersion !== TRUTH_KERNEL_SERIALIZATION_VERSION) failures.push(failure('serialization-version-unsupported', 'unsupported chain serialization version', artifact.relativePath))
    const receipt = receipts.get(chain.sourceIngestReceiptId)
    if (!receipt || receipt.parserId !== chain.parserId || receipt.parserVersion !== chain.parserVersion || !manifest.parserVersions.some((item) => item.parserId === chain.parserId && item.parserVersion === chain.parserVersion)) failures.push(failure('parser-version-mismatch', 'chain parser version does not match receipt and manifest', artifact.relativePath))
    if (chain.entries.length !== chain.expectedEventCount) failures.push(failure('event-missing', 'event count differs from frozen chain count', artifact.relativePath, String(chain.expectedEventCount), String(chain.entries.length)))
    const seen = new Set<string>()
    let previous: string | null = null
    for (let index = 0; index < chain.entries.length; index += 1) {
      const entry = chain.entries[index]
      if (seen.has(entry.eventId)) failures.push(failure('event-duplicate', 'duplicate event identity', artifact.relativePath))
      seen.add(entry.eventId)
      if (entry.sequence !== index) failures.push(failure('event-reordered', 'event sequence is not contiguous in exported order', artifact.relativePath, String(index), String(entry.sequence)))
      const eventArtifact = eventArtifacts.get(entry.eventId)
      const eventBytes = eventArtifact && bundle.files.get(eventArtifact.relativePath)
      if (!eventArtifact || !eventBytes) { failures.push(failure('event-missing', 'chained event artifact missing', `events/${entry.eventId}.json`)); continue }
      const eventDigest = digest(eventBytes)
      if (eventDigest !== entry.eventDigest || eventArtifact.sha256 !== entry.eventDigest) failures.push(failure('event-digest-mismatch', 'event bytes do not match chain digest', eventArtifact.relativePath, entry.eventDigest, eventDigest))
      const linked = index === 0 ? entry.previousChainHash.status !== 'available' : entry.previousChainHash.status === 'available' && entry.previousChainHash.value === previous
      if (!linked) failures.push(failure('chain-link-invalid', 'previous chain hash does not link to prior entry', artifact.relativePath))
      const expectedHash = truthKernelRollingChainHash({ sourceIngestReceiptId: chain.sourceIngestReceiptId, parserId: chain.parserId, parserVersion: chain.parserVersion, serializationVersion: chain.serializationVersion, sequence: entry.sequence, previousChainHash: previous, eventDigest: entry.eventDigest })
      if (expectedHash !== entry.chainHash) failures.push(failure('chain-link-invalid', 'rolling chain hash mismatch', artifact.relativePath, expectedHash, entry.chainHash))
      previous = entry.chainHash
    }
    const manifestHead = manifest.chainHeads.find((item) => item.chainId === chain.chainId)?.headHash
    const chainHead = chain.headHash.status === 'available' ? chain.headHash.value : undefined
    if (previous !== chainHead || chainHead !== manifestHead) failures.push(failure('chain-link-invalid', 'chain head does not match entries and manifest', artifact.relativePath, manifestHead, chainHead))
  }
  const verifier = byKind('offline-verifier').find((artifact) => artifact.objectId === manifest.verifier.verifierId)
  if (!verifier || verifier.sha256 !== manifest.verifier.sha256) failures.push(failure('bundle-artifact-missing', 'offline verifier is not bound by manifest', 'verify/swob-verify.mjs'))
  return { schemaVersion: 1, verificationId: `verify:${manifest.bundleId}:${checkedAt}`, target: { kind: 'bundle', id: manifest.bundleId }, checkedAt, verifierId: 'swob-offline-verifier', verifierKind: 'built-in-offline', verifierVersion: '1', status: failures.length ? 'invalid' : 'valid', failures }
}

/** Feature-local command core; CLI-root wiring is intentionally left to t211I. */
export async function runSwobVerify(bundleDirectory: string, checkedAt = new Date().toISOString()): Promise<VerificationResult> {
  const root = await realpathDirectory(bundleDirectory)
  const files = new Map<string, Uint8Array>()
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name)
      if (entry.isSymbolicLink()) throw new Error('external-evidence:bundle-symlink-rejected')
      if (entry.isDirectory()) await visit(absolute)
      else if (entry.isFile()) files.set(relative(root, absolute).split(sep).join('/'), new Uint8Array(await readFile(absolute)))
    }
  }
  await visit(root)
  const bytes = files.get('manifest.json')
  if (!bytes) throw new Error('external-evidence:manifest-missing')
  return verifyEvidenceBundle({ manifest: json<VerifyBundleManifest>(bytes), files }, checkedAt)
}

async function realpathDirectory(directory: string): Promise<string> {
  const { realpath, stat } = await import('node:fs/promises')
  const root = await realpath(directory)
  if (!(await stat(root)).isDirectory()) throw new Error('external-evidence:bundle-not-directory')
  return root
}
