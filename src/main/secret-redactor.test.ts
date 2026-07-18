import { describe, expect, it } from 'vitest'
import { redactSecrets } from './secret-redactor'

const highEntropyA = `WK${'a'.repeat(34)}`
const highEntropyB = `SK${'b'.repeat(34)}`

function connectionString(scheme: string, user: string, password: string, hostAndPath: string): string {
  return `${scheme}${'://'}${user}${':'}${password}${'@'}${hostAndPath}`
}

describe('redactSecrets', () => {
  it('打码全部常见前缀 token', () => {
    const candidates = [
      `s${'k-'}${'a'.repeat(22)}`,
      `g${'hp_'}${'a'.repeat(36)}`,
      `g${'ho_'}${'a'.repeat(36)}`,
      `g${'ithub_pat_'}${'a'.repeat(22)}`,
      `x${'oxb-'}${'a'.repeat(10)}`,
      `A${'KIA'}${'A'.repeat(16)}`,
      `A${'Iza'}${'a'.repeat(35)}`,
      `y${'a29.'}${'a'.repeat(20)}`
    ]
    const result = redactSecrets(candidates.join('\n'))
    expect(result.hits).toBe(candidates.length)
    expect(result.text).not.toContain(candidates[0])
  })

  it('打码 PEM 私钥整块', () => {
    const begin = ['-----BEGIN PRI', 'VATE KEY-----'].join('')
    const end = ['-----END PRI', 'VATE KEY-----'].join('')
    const pem = [begin, 'private-material', end].join('\n')
    const result = redactSecrets(`before\n${pem}\nafter`)
    expect(result.hits).toBe(1)
    expect(result.text).not.toContain('private-material')
    expect(result.text).toContain('--……----（已脱敏）')
  })

  it('打码高熵 WK/SK token 与 JWT', () => {
    const jwt = `e${'yJ'}${'a'.repeat(24)}.${'b'.repeat(12)}.${'c'.repeat(12)}`
    const result = redactSecrets(`${highEntropyA}\n${highEntropyB}\n${jwt}`)
    expect(result.hits).toBe(3)
    expect(result.text).toContain('WK……aaaa（已脱敏）')
    expect(result.text).toContain('SK……bbbb（已脱敏）')
    expect(result.text).toContain('ey……cccc（已脱敏）')
  })

  it('白名单不会误伤 UUID、git SHA、data image、Markdown URL 或普通文本', () => {
    const uuid = '123e4567-e89b-12d3-a456-426614174000'
    const sha = 'abcdef0123456789abcdef0123456789abcdef01'
    const result = redactSecrets([
      uuid,
      sha,
      `data:image/png;base64,${highEntropyA}`,
      `[download](https://example.test/files/${highEntropyA})`,
      '这是正常的中文长句，不包含任何凭据，只是用于确认不会被误伤。',
      'ordinaryenglishwordsremainunchanged'
    ].join('\n'))
    expect(result.hits).toBe(0)
    expect(result.text).toContain(uuid)
    expect(result.text).toContain(sha)
    expect(result.text).toContain(highEntropyA)
  })

  it('保留格式固定且幂等', () => {
    const once = redactSecrets(highEntropyA)
    expect(once.text).toBe('WK……aaaa（已脱敏）')
    expect(redactSecrets(once.text)).toEqual({ text: once.text, hits: 0 })
  })

  it('仅打码 SQL、Redis 与 MongoDB 连接串的 password 段', () => {
    const inputs = [
      connectionString('postgresql', 'neon_user', 'plain-neon-password', 'db.example.test/app?sslmode=require'),
      connectionString('mysql', 'app_user', 'mysql-password', 'mysql.example.test:3306/app'),
      connectionString('redis', 'cache_user', 'redis-password', 'cache.example.test:6379/0'),
      connectionString('rediss', 'cache_user', 'secure-redis-password', 'cache.example.test:6380/0'),
      connectionString('mongodb', 'mongo_user', 'mongo-password', 'mongo.example.test/app'),
      connectionString('mongodb+srv', 'atlas_user', 'atlas-password', 'cluster.example.test/app')
    ]
    const result = redactSecrets(inputs.join('\n'))

    expect(result.hits).toBe(inputs.length)
    expect(result.text).toContain(connectionString('postgresql', 'neon_user', 'xx……word（已脱敏）', 'db.example.test/app?sslmode=require'))
    expect(result.text).toContain(connectionString('redis', 'cache_user', 'xx……word（已脱敏）', 'cache.example.test:6379/0'))
    expect(result.text).toContain(connectionString('mongodb+srv', 'atlas_user', 'xx……word（已脱敏）', 'cluster.example.test/app'))
    for (const input of inputs) expect(result.text).not.toContain(input)
  })

  it('连接串 password 打码幂等，短密码不回显', () => {
    const input = connectionString('postgresql', 'user', 'p4', 'db.example.test/app')
    const expected = connectionString('postgresql', 'user', 'xx……（已脱敏）', 'db.example.test/app')
    const once = redactSecrets(input)
    expect(once).toEqual({ text: expected, hits: 1 })
    expect(redactSecrets(once.text)).toEqual({ text: once.text, hits: 0 })
  })

  it('无凭据 URL 及非数据库 userinfo URL 不误伤', () => {
    const safe = [
      `postgresql${'://'}db.example.test/app?sslmode=require`,
      `redis${'://'}cache.example.test:6379/0`,
      `mongodb+srv${'://'}cluster.example.test/app`,
      connectionString('https', 'user', 'password', 'example.test/private'),
      `https${'://'}example.test/ordinary/path`
    ].join('\n')

    expect(redactSecrets(safe)).toEqual({ text: safe, hits: 0 })
  })
})
