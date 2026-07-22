import { callLlm, type LlmSettings } from './llm-client'
import { LlmProfileError } from './llm-profiles'
import { redactSecrets } from './secret-redactor'

export interface SmartRenameCandidate {
  id: string
  oldTitle: string
  firstUserMessage: string
  conversationSummary: string
}

export interface SmartRenamePreviewItem {
  id: string
  oldTitle: string
  newTitle: string
}

export interface SmartRenameApplyItem {
  id: string
  newTitle: string
}

export type SmartRenameErrorCode =
  | 'INVALID_INPUT'
  | 'SESSION_NOT_FOUND'
  | 'PROFILE_NOT_BOUND'
  | 'PROFILE_NOT_FOUND'
  | 'PROFILE_KEY_MISSING'
  | 'KEYCHAIN_UNAVAILABLE'
  | 'LLM_REQUEST_FAILED'
  | 'LLM_RESPONSE_INVALID'
  | 'WRITE_FAILED'

export class SmartRenameError extends Error {
  constructor(
    readonly code: SmartRenameErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'SmartRenameError'
  }
}

export interface SmartRenameFailure {
  code: SmartRenameErrorCode
}

type LlmCaller = (
  settings: LlmSettings,
  systemPrompt: string,
  userPrompt: string,
  maxTokens?: number
) => Promise<string>

export interface SmartRenameDependencies {
  resolveProfile: () => Promise<LlmSettings>
  loadCandidates: (sessionIds: readonly string[]) => Promise<SmartRenameCandidate[]>
  setCustomTitle: (sessionId: string, title: string) => void | Promise<void>
  call?: LlmCaller
}

const MAX_BATCH_SIZE = 50
const MAX_CONTEXT_CHARS = 3_000
const MAX_TITLE_CHARS = 30
const FORBIDDEN_TITLE_END = /[，。！？；：,.!?;:]$/u

function clip(value: string, maxLength: number): string {
  return Array.from(value).slice(0, maxLength).join('')
}

function safeContext(value: string): string {
  return redactSecrets(clip(value || '', MAX_CONTEXT_CHARS)).text
}

function validateSessionIds(sessionIds: readonly string[]): string[] {
  if (!Array.isArray(sessionIds) || sessionIds.length === 0 || sessionIds.length > MAX_BATCH_SIZE) {
    throw new SmartRenameError('INVALID_INPUT', `每次需选择 1–${MAX_BATCH_SIZE} 个会话`)
  }
  const normalized: string[] = []
  const seen = new Set<string>()
  for (const value of sessionIds) {
    const id = typeof value === 'string' ? value.trim() : ''
    if (!id || id.length > 300 || /[\r\n]/.test(id)) {
      throw new SmartRenameError('INVALID_INPUT', '会话 ID 无效')
    }
    if (!seen.has(id)) normalized.push(id)
    seen.add(id)
  }
  return normalized
}

function validateTitle(
  value: unknown,
  errorCode: 'INVALID_INPUT' | 'LLM_RESPONSE_INVALID' = 'LLM_RESPONSE_INVALID'
): string {
  if (typeof value !== 'string') {
    throw new SmartRenameError(errorCode, '标题必须是文本')
  }
  const title = value.trim().replace(/\s+/g, ' ')
  if (!title || Array.from(title).length > MAX_TITLE_CHARS || FORBIDDEN_TITLE_END.test(title)) {
    throw new SmartRenameError(errorCode, '标题不符合 30 字与无句末标点约束')
  }
  return title
}

export function buildSmartRenamePrompt(
  candidates: readonly SmartRenameCandidate[],
  retry = false
): { systemPrompt: string; userPrompt: string } {
  const payload = {
    sessions: candidates.map((candidate) => ({
      id: candidate.id,
      currentTitle: safeContext(candidate.oldTitle),
      firstUserMessage: safeContext(candidate.firstUserMessage),
      conversationSummary: safeContext(candidate.conversationSummary)
    }))
  }
  return {
    systemPrompt: [
      '你为 AI 编程会话生成可扫描、可区分的短标题。',
      '标题跟随该会话的主要语言；中文标题不超过 30 个字。',
      '标题以动词开头，不带句末标点，不要编号。',
      '只返回严格 JSON，不要 Markdown、解释或代码围栏。',
      '格式必须是：{"titles":{"<session-id>":"<title>"}}。',
      'titles 必须且只能包含输入中的全部 session id。',
      ...(retry ? ['上一次输出格式无效；这是最后一次机会，请严格遵守 JSON schema。'] : [])
    ].join('\n'),
    userPrompt: JSON.stringify(payload)
  }
}

export function parseSmartRenameResponse(
  raw: string,
  expectedSessionIds: readonly string[]
): Record<string, string> {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw.trim())
  } catch {
    throw new SmartRenameError('LLM_RESPONSE_INVALID', '模型未返回严格 JSON')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new SmartRenameError('LLM_RESPONSE_INVALID', '模型返回结构无效')
  }
  const root = parsed as Record<string, unknown>
  if (Object.keys(root).length !== 1 || !root.titles || typeof root.titles !== 'object' || Array.isArray(root.titles)) {
    throw new SmartRenameError('LLM_RESPONSE_INVALID', '模型返回缺少 titles 对象')
  }
  const titles = root.titles as Record<string, unknown>
  const expected = new Set(expectedSessionIds)
  const actualIds = Object.keys(titles)
  if (actualIds.length !== expected.size || actualIds.some((id) => !expected.has(id))) {
    throw new SmartRenameError('LLM_RESPONSE_INVALID', '模型返回的会话集合不完整')
  }
  return Object.fromEntries(expectedSessionIds.map((id) => [id, validateTitle(titles[id])]))
}

export async function requestSmartRename(
  settings: LlmSettings,
  candidates: readonly SmartRenameCandidate[],
  caller: LlmCaller = callLlm
): Promise<Record<string, string>> {
  const expectedIds = candidates.map((candidate) => candidate.id)
  for (let attempt = 0; attempt < 2; attempt++) {
    const prompt = buildSmartRenamePrompt(candidates, attempt === 1)
    let raw: string
    try {
      raw = await caller(
        settings,
        prompt.systemPrompt,
        prompt.userPrompt,
        Math.min(4096, Math.max(512, candidates.length * 96))
      )
    } catch {
      throw new SmartRenameError('LLM_REQUEST_FAILED', '模型调用失败，请检查 Profile 配置或网络')
    }
    try {
      return parseSmartRenameResponse(raw, expectedIds)
    } catch (error) {
      if (attempt === 1) throw error
    }
  }
  throw new SmartRenameError('LLM_RESPONSE_INVALID', '模型连续两次返回无效 JSON')
}

export class SmartRenameService {
  constructor(private readonly dependencies: SmartRenameDependencies) {}

  async preview(sessionIds: readonly string[]): Promise<SmartRenamePreviewItem[]> {
    const ids = validateSessionIds(sessionIds)
    let settings: LlmSettings
    try {
      settings = await this.dependencies.resolveProfile()
    } catch (error) {
      if (error instanceof LlmProfileError) {
        throw new SmartRenameError(error.code as SmartRenameErrorCode, error.message)
      }
      throw new SmartRenameError('PROFILE_NOT_FOUND', '无法解析智能重命名 Profile')
    }
    const candidates = await this.dependencies.loadCandidates(ids)
    const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]))
    const missing = ids.find((id) => !byId.has(id))
    if (missing) throw new SmartRenameError('SESSION_NOT_FOUND', `找不到会话：${missing}`)
    const ordered = ids.map((id) => byId.get(id)!)
    const titles = await requestSmartRename(settings, ordered, this.dependencies.call)
    return ordered.map((candidate) => ({
      id: candidate.id,
      oldTitle: candidate.oldTitle,
      newTitle: titles[candidate.id]
    }))
  }

  async apply(items: readonly SmartRenameApplyItem[]): Promise<SmartRenameApplyItem[]> {
    if (!Array.isArray(items) || items.length === 0 || items.length > MAX_BATCH_SIZE) {
      throw new SmartRenameError('INVALID_INPUT', `每次需提交 1–${MAX_BATCH_SIZE} 个重命名结果`)
    }
    const normalized = items.map((item) => {
      const id = typeof item?.id === 'string' ? item.id.trim() : ''
      if (!id || /[\r\n]/.test(id)) throw new SmartRenameError('INVALID_INPUT', '会话 ID 无效')
      return { id, newTitle: validateTitle(item.newTitle, 'INVALID_INPUT') }
    })
    if (new Set(normalized.map((item) => item.id)).size !== normalized.length) {
      throw new SmartRenameError('INVALID_INPUT', '重命名列表包含重复会话')
    }
    try {
      for (const item of normalized) {
        await this.dependencies.setCustomTitle(item.id, item.newTitle)
      }
    } catch {
      throw new SmartRenameError('WRITE_FAILED', '写入 Swob 自定义标题失败')
    }
    return normalized
  }
}

export function serializeSmartRenameError(error: unknown): SmartRenameFailure {
  if (error instanceof SmartRenameError) return { code: error.code }
  return { code: 'WRITE_FAILED' }
}
