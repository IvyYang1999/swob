import { describe, expect, it } from 'vitest'
import {
  assertPrivacyClean,
  derivePrivacySalt,
  hostHash,
  redactPath,
  saltedId,
  scanForPrivacy,
  scanTextForPrivacy,
  unitSignature
} from './privacy'
import { FINDING_TEXT, HEADLINES, OWNER_ACTIONS, SOURCE_LABELS, fillTemplate, registeredTemplateSet } from './templates'
import { FIXED_ROOTS, REASON_CODES } from './contract'

const CANARIES = {
  absolutePath: '/Users/canary-user/secret-project/src',
  uuid: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
  userText: '独角兽金丝雀原文，千万不要出现在报告里，谢谢配合',
  rollout: 'rollout-2026-09-20T10-11-12-f47ac10b-58cc-4372-a567-0e02b2c3d479.jsonl'
}

function cleanFragment(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    generatedAt: '2026-09-26T12:00:00.000Z',
    kernel: { version: '1.4.0', commit: '4971632ac809b012357461c2f96f04a8a281eac5', checkupVersion: '1.0.0' },
    machine: { platform: 'darwin', hostHash: 'deadbeef', nodeVersion: 'v24.21.0' },
    checks: [{
      id: 'content',
      verdict: 'fail',
      headline: fillTemplate(HEADLINES['content.loss'], [55, 21]),
      ownerAction: OWNER_ACTIONS.fail,
      bySource: {
        'claude-code': {
          verdict: 'fail',
          swob: { mainRead: { value: 166881, label: 'reported', unit: 'records' } },
          oracle: { mainParseable: { value: 166936, label: 'reported', unit: 'records' } },
          oracleIds: ['census.claude-jsonl']
        }
      },
      findings: [{
        code: 'content.line-separator-split',
        verdict: 'fail',
        source: 'claude-code',
        count: { value: 55, label: 'derived', unit: 'records' },
        ownerLine: fillTemplate(FINDING_TEXT['content.line-separator-split']!.ownerLine, [55, 20], 'claude-code'),
        engineerHint: fillTemplate(FINDING_TEXT['content.line-separator-split']!.engineerHint),
        samples: ['0a1b2c3d']
      }]
    }],
    inventory: [{ source: 'trae', root: '~/Library/Application Support/Trae/User', timeRange: ['2026-04-29T00:00:00.000Z', null] }],
    units: [{ id: '01234567', unitSig: '89abcdef', kind: 'claude-main', bucket: 'session', records: { 'queue-operation': 3, 'event_msg:token_count': 4 } }]
  }
}

describe('privacy primitives', () => {
  it('derives salted 8-hex ids that depend on the salt', () => {
    expect(saltedId('a', 'x')).toMatch(/^[0-9a-f]{8}$/)
    expect(saltedId('a', 'x')).toBe(saltedId('a', 'x'))
    expect(saltedId('a', 'x')).not.toBe(saltedId('b', 'x'))
    expect(unitSignature('a', '/p', 1, 2)).not.toBe(unitSignature('a', '/p', 1, 3))
    expect(hostHash('a', 'host')).toMatch(/^[0-9a-f]{8}$/)
  })

  it('derives a stable in-memory salt from machine values', () => {
    const salt = derivePrivacySalt({ uid: 501, hostname: 'h', homeDir: '/home/u' })
    expect(salt).toMatch(/^[0-9a-f]{64}$/)
    expect(derivePrivacySalt({ uid: 501, hostname: 'h', homeDir: '/home/u' })).toBe(salt)
    expect(derivePrivacySalt({ uid: 502, hostname: 'h', homeDir: '/home/u' })).not.toBe(salt)
    expect(derivePrivacySalt()).toMatch(/^[0-9a-f]{64}$/)
  })

  it('redacts paths to fixed roots or salted placeholders', () => {
    expect(redactPath('/home/u/.codex/sessions', '/home/u', 's')).toBe('~/.codex/sessions')
    expect(redactPath(CANARIES.absolutePath, '/home/u', 's')).toMatch(/^<path:[0-9a-f]{8}>$/)
  })
})

describe('privacy scanner', () => {
  it('accepts a report made only of registered values', () => {
    expect(scanForPrivacy(cleanFragment())).toEqual({ ok: true, hits: [] })
  })

  it('accepts every registered template, reason code and fixed root', () => {
    const values: string[] = [...REASON_CODES, ...FIXED_ROOTS, ...Object.values(OWNER_ACTIONS)]
    for (const template of Object.values(HEADLINES)) values.push(fillTemplate(template, [1, 22, 333, 4444]))
    for (const [code, text] of Object.entries(FINDING_TEXT)) {
      for (const source of Object.keys(SOURCE_LABELS)) {
        values.push(fillTemplate(text!.ownerLine, [1234, 56.789], source), fillTemplate(text!.engineerHint, [], source))
      }
      expect(code).toMatch(/^[a-z0-9-]+\.[a-z0-9.-]+$/)
    }
    const result = scanForPrivacy({ values })
    expect(result.hits).toEqual([])
    expect(registeredTemplateSet().size).toBeGreaterThan(50)
  })

  for (const [name, canary] of Object.entries(CANARIES)) {
    it(`rejects the ${name} canary as a value and never echoes it`, () => {
      const fragment = cleanFragment()
      ;(fragment.checks as Array<Record<string, unknown>>)[0].headline = canary
      const result = scanForPrivacy(fragment)
      expect(result.ok).toBe(false)
      expect(JSON.stringify(result)).not.toContain(canary)
      expect(() => assertPrivacyClean(fragment)).toThrow(/privacy scan rejected/)
    })
  }

  it('rejects canaries hidden in object keys, samples and embedded in template-like sentences', () => {
    expect(scanForPrivacy({ recordTypes: { [CANARIES.uuid]: 1 } }).ok).toBe(false)
    expect(scanForPrivacy({ samples: ['0123456789abcdef'] }).ok).toBe(false)
    expect(scanForPrivacy({ ownerLine: `${fillTemplate(HEADLINES['content.pass'])} ${CANARIES.userText}` }).ok).toBe(false)
    expect(scanForPrivacy({ hint: 'see summary-cache.sqlite' }).hits.map((hit) => hit.rule)).toContain('data-file-name')
    expect(scanForPrivacy({ code: 'content.made-up-code' }).ok).toBe(false)
    expect(scanForPrivacy({ hint: 'C:\\Users\\x' }).ok).toBe(false)
    expect(scanForPrivacy({ note: 'short free text' }).ok).toBe(false)
    expect(scanForPrivacy({ commit: '4971632ac809b012357461c2f96f04a8a281eac5' }).ok).toBe(false)
  })

  it('scans free console text heuristically', () => {
    expect(scanTextForPrivacy(`loaded ${CANARIES.absolutePath}`)).toContain('absolute-path')
    expect(scanTextForPrivacy(`id ${CANARIES.uuid}`)).toContain('uuid')
    expect(scanTextForPrivacy('parsed 12 files')).toEqual([])
  })
})
