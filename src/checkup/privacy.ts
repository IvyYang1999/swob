/**
 * Privacy primitives for the kernel checkup.
 *
 * - Salted 8-hex sample ids. The salt is derived in memory from the machine
 *   identifier (never the hostname, which changes with the network), is never
 *   written to disk and never placed in a report; only its 8-hex fingerprint is.
 * - Path redaction for diagnostics.
 * - A two-layer scanner that must pass before any report is written:
 *   ① whitelist: every string is a registered enum/code/source/unit/root, an
 *      8-hex id, an ISO time, a version, or a registered template sentence;
 *   ② heuristics: absolute paths, data-file names, UUIDs, Codex rollout names,
 *      long hex runs and non-template text fragments of 20+ characters.
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  FIXED_ROOTS,
  INCLUSION_BUCKETS,
  MEASURE_UNITS,
  ORACLE_IDS,
  REASON_CODES,
  REPORT_ENUMS,
  SELF_TEST_CASES,
  SOURCE_IDS,
  UNIT_KINDS
} from './contract'
import { SOURCE_LABELS, normalizeTemplateText, registeredTemplateSet } from './templates'

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

// —— salt ——

/** Fixed domain-separation constant mixed into the salt. */
const SALT_DOMAIN = 'swob-kernel-checkup-salt/v2'

export type MachineIdentitySource = 'io-platform-uuid' | 'machine-id' | 'machine-guid' | 'user-home'
export interface MachineIdentity { source: MachineIdentitySource; value: string }

const UUID_TEXT = /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/
const MACHINE_ID_TEXT = /^[0-9a-f]{32}$/

/** `ioreg -rd1 -c IOPlatformExpertDevice` output → IOPlatformUUID (upper case), or null. */
export function parseIoregPlatformUuid(output: string): string | null {
  const match = /"IOPlatformUUID"\s*=\s*"([^"]+)"/.exec(output)
  return match && UUID_TEXT.test(match[1]) ? match[1].toUpperCase() : null
}

/** Windows `reg query` of the Cryptography key's MachineGuid value → MachineGuid (lower case), or null. */
export function parseWindowsMachineGuid(output: string): string | null {
  const match = /MachineGuid\s+REG_SZ\s+(\S+)/i.exec(output)
  return match && UUID_TEXT.test(match[1]) ? match[1].toLowerCase() : null
}

/** `/etc/machine-id` content → 32 lower-case hex, or null. */
export function parseLinuxMachineId(content: string): string | null {
  const value = content.trim().toLowerCase()
  return MACHINE_ID_TEXT.test(value) ? value : null
}

function commandOutput(command: string, args: string[]): string | null {
  try {
    return execFileSync(command, args, {
      encoding: 'utf8',
      timeout: 5000,
      maxBuffer: 4 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true
    })
  } catch {
    return null
  }
}

/** Read the platform machine identifier without writing anything; null when unavailable. */
export function readMachineIdentifier(platform: NodeJS.Platform = process.platform): MachineIdentity | null {
  if (platform === 'darwin') {
    const output = commandOutput('/usr/sbin/ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'])
    const value = output === null ? null : parseIoregPlatformUuid(output)
    return value ? { source: 'io-platform-uuid', value } : null
  }
  if (platform === 'linux') {
    for (const file of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
      try {
        const value = parseLinuxMachineId(fs.readFileSync(file, 'utf8'))
        if (value) return { source: 'machine-id', value }
      } catch { /* try the next location */ }
    }
    return null
  }
  if (platform === 'win32') {
    const output = commandOutput('reg', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'])
    const value = output === null ? null : parseWindowsMachineGuid(output)
    return value ? { source: 'machine-guid', value } : null
  }
  return null
}

export interface MachineIdentityOptions {
  platform?: NodeJS.Platform
  readMachineId?: (platform: NodeJS.Platform) => MachineIdentity | null
}

/** Machine identifier, falling back to `os.userInfo()` username + home directory. No hostname. */
export function machineIdentity(options: MachineIdentityOptions = {}): MachineIdentity {
  const identity = (options.readMachineId ?? readMachineIdentifier)(options.platform ?? process.platform)
  if (identity) return identity
  const info = os.userInfo()
  return { source: 'user-home', value: `${info.username}\0${info.homedir}` }
}

/** Salt = sha256(fixed constant + machine identity). */
export function saltFromMachineIdentity(identity: MachineIdentity): string {
  return sha256Hex(`${SALT_DOMAIN}\0${identity.value}`)
}

let defaultSalt: string | null = null

/** Stable per-machine salt, kept in memory only (never written, never reported). */
export function derivePrivacySalt(options?: MachineIdentityOptions): string {
  if (options) return saltFromMachineIdentity(machineIdentity(options))
  defaultSalt ??= saltFromMachineIdentity(machineIdentity())
  return defaultSalt
}

/** First 8 hex of sha256(salt): lets a later comparison check that two reports used the same salt. */
export function saltFingerprint(salt: string): string {
  return sha256Hex(salt).slice(0, 8)
}

/** Salted 8-hex identifier (the only sample id format reports may carry). */
export function saltedId(salt: string, value: string): string {
  return sha256Hex(`${salt}\0${value}`).slice(0, 8)
}

/** Run-to-run comparison signature of a physical unit (decision 5: path hash + mtime + size). */
export function unitSignature(salt: string, realPath: string, mtimeMs: number, size: number): string {
  return sha256Hex(`${saltedId(salt, `unit:${realPath}`)}\0${mtimeMs}\0${size}`).slice(0, 8)
}

export function hostHash(salt: string, hostname = os.hostname()): string {
  return saltedId(salt, `host:${hostname}`)
}

/**
 * Redact a path for diagnostics: fixed roots under `homeDir` become `~/...`
 * templates; anything else becomes `<path:xxxxxxxx>` (salted).
 */
export function redactPath(filePath: string, homeDir: string, salt: string): string {
  const relative = path.relative(homeDir, filePath)
  if (!relative.startsWith('..') && !path.isAbsolute(relative)) {
    const candidate = `~/${relative.split(path.sep).join('/')}`
    if ((FIXED_ROOTS as readonly string[]).includes(candidate)) return candidate
  }
  return `<path:${saltedId(salt, `path:${filePath}`)}>`
}

// —— scanner ——

export interface PrivacyHit { path: string; layer: 'whitelist' | 'heuristic'; rule: string }
export interface PrivacyScanResult { ok: boolean; hits: PrivacyHit[] }

const HEX8 = /^[0-9a-f]{8}$/
const ISO_TIME = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})?)?$/
const VERSION = /^v?\d{1,6}(?:\.\d{1,6}){0,3}(?:[-+][0-9A-Za-z.]{1,32})?$/
const COMMIT = /^[0-9a-f]{40}$|^[0-9a-f]{7,12}$/
const KEY = /^[A-Za-z][A-Za-z0-9_]*(?:[-.:][A-Za-z0-9_]+)*$/
const IDENTIFIER = /^[A-Za-z0-9_.:\-]+$/

const ABSOLUTE_PATH = /(?:^|[^A-Za-z0-9_.~$<-])\/(?:Users|private|var|tmp|home|Volumes|opt|etc)\//
const DATA_FILE = /[A-Za-z0-9_.-]+\.(?:jsonl|json|sqlite|db)(?![A-Za-z0-9])/i
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i
const ROLLOUT = /rollout-\d{4}-\d{2}-\d{2}T\d{2}[-:]\d{2}[-:]\d{2}/i
const LONG_HEX = /[0-9a-f]{12,}/i
const WINDOWS_PATH = /[A-Za-z]:\\/
const TEXT_FRAGMENT_MIN = 20

let cachedValueWhitelist: Set<string> | null = null
function valueWhitelist(): Set<string> {
  if (cachedValueWhitelist) return cachedValueWhitelist
  cachedValueWhitelist = new Set<string>([
    ...REASON_CODES, ...REPORT_ENUMS, ...SOURCE_IDS, ...MEASURE_UNITS, ...ORACLE_IDS,
    ...FIXED_ROOTS, ...UNIT_KINDS, ...INCLUSION_BUCKETS, ...SELF_TEST_CASES,
    ...Object.keys(SOURCE_LABELS)
  ])
  return cachedValueWhitelist
}

function heuristicRule(text: string, isRegistered: boolean): string | null {
  if (UUID.test(text)) return 'uuid'
  if (ROLLOUT.test(text)) return 'codex-rollout-name'
  if (ABSOLUTE_PATH.test(text) || WINDOWS_PATH.test(text)) return 'absolute-path'
  if (DATA_FILE.test(text)) return 'data-file-name'
  if (!isRegistered && LONG_HEX.test(text) && !COMMIT.test(text)) return 'long-hex'
  if (!isRegistered && text.length >= TEXT_FRAGMENT_MIN && !IDENTIFIER.test(text)) return 'text-fragment'
  return null
}

function valueCategory(text: string, jsonPath: string[]): string | null {
  if (valueWhitelist().has(text)) return 'registry'
  if (HEX8.test(text)) return 'hex8'
  if (ISO_TIME.test(text)) return 'iso-time'
  if (VERSION.test(text)) return 'version'
  if (jsonPath.join('.') === 'kernel.commit' && COMMIT.test(text)) return 'commit'
  if (registeredTemplateSet().has(normalizeTemplateText(text))) return 'template'
  return null
}

const SAFE_PATH_SEGMENT = /^(?:\d+|[A-Za-z][A-Za-z0-9_]{0,40})$/

function displayPath(jsonPath: string[]): string {
  return jsonPath.map((segment) => SAFE_PATH_SEGMENT.test(segment) && !LONG_HEX.test(segment) ? segment : '*').join('.')
}

/**
 * Scan any JSON-able value. Hits never echo the offending text: only a
 * redacted JSON path and the rule name.
 */
export function scanForPrivacy(value: unknown): PrivacyScanResult {
  const hits: PrivacyHit[] = []
  const visit = (node: unknown, jsonPath: string[]): void => {
    if (typeof node === 'string') {
      const category = valueCategory(node, jsonPath)
      if (!category) hits.push({ path: displayPath(jsonPath), layer: 'whitelist', rule: 'unregistered-string' })
      const rule = heuristicRule(node, category === 'template' || category === 'registry')
      if (rule) hits.push({ path: displayPath(jsonPath), layer: 'heuristic', rule })
      return
    }
    if (node === null || typeof node === 'number' || typeof node === 'boolean') return
    if (Array.isArray(node)) {
      node.forEach((item, index) => visit(item, [...jsonPath, String(index)]))
      return
    }
    if (typeof node === 'object') {
      for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
        if (!KEY.test(key) || key.length > 64) {
          hits.push({ path: displayPath(jsonPath), layer: 'whitelist', rule: 'unregistered-key' })
        }
        const rule = heuristicRule(key, false)
        if (rule && rule !== 'text-fragment') hits.push({ path: displayPath(jsonPath), layer: 'heuristic', rule: `key-${rule}` })
        visit(child, [...jsonPath, key])
      }
      return
    }
    hits.push({ path: displayPath(jsonPath), layer: 'whitelist', rule: `unsupported-${typeof node}` })
  }
  visit(value, [])
  return { ok: hits.length === 0, hits }
}

export class PrivacyViolationError extends Error {
  readonly hits: PrivacyHit[]
  constructor(hits: PrivacyHit[]) {
    super(`privacy scan rejected the report (${hits.length} hit${hits.length === 1 ? '' : 's'})`)
    this.name = 'PrivacyViolationError'
    this.hits = hits
  }
}

export function assertPrivacyClean(value: unknown): void {
  const result = scanForPrivacy(value)
  if (!result.ok) throw new PrivacyViolationError(result.hits)
}

/** Scan free text such as captured console output (heuristic layer only). */
export function scanTextForPrivacy(text: string): string[] {
  const rules = new Set<string>()
  for (const line of text.split('\n')) {
    if (UUID.test(line)) rules.add('uuid')
    if (ROLLOUT.test(line)) rules.add('codex-rollout-name')
    if (ABSOLUTE_PATH.test(line) || WINDOWS_PATH.test(line)) rules.add('absolute-path')
    if (DATA_FILE.test(line)) rules.add('data-file-name')
  }
  return [...rules]
}
