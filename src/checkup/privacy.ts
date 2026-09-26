/**
 * Privacy primitives for the kernel checkup.
 *
 * - Salted 8-hex sample ids (the salt is derived in memory; it is never written
 *   to disk and never placed in a report).
 * - Path redaction for diagnostics.
 * - A two-layer scanner that must pass before any report is written:
 *   ① whitelist: every string is a registered enum/code/source/unit/root, an
 *      8-hex id, an ISO time, a version, or a registered template sentence;
 *   ② heuristics: absolute paths, data-file names, UUIDs, Codex rollout names,
 *      long hex runs and non-template text fragments of 20+ characters.
 */
import { createHash } from 'node:crypto'
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

/** Stable per-machine salt: uid + hostname + real home, hashed. Kept in memory only. */
export function derivePrivacySalt(input: { uid?: number; hostname?: string; homeDir?: string } = {}): string {
  let uid = input.uid
  let homeDir = input.homeDir
  if (uid === undefined || homeDir === undefined) {
    const info = os.userInfo()
    uid ??= info.uid
    homeDir ??= info.homedir
  }
  const hostname = input.hostname ?? os.hostname()
  return sha256Hex(`swob-checkup-salt\0${uid}\0${hostname}\0${homeDir}`)
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
