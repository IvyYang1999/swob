import { callLlm, type LlmSettings } from './llm-client'
import { redactSecrets } from './secret-redactor'
import { sanitizeRelativeFolder } from './vault-organizer'

export interface SmartOrganizerSession {
  sessionId: string
  title: string
  summary: string
}

export interface SmartOrganizationSuggestion {
  sessionId: string
  folder: string
  topic: string
  tags: string[]
  confidence: number
}

type LlmCaller = (
  settings: LlmSettings,
  systemPrompt: string,
  userPrompt: string,
  maxTokens?: number
) => Promise<string>

function redactedSnippet(value: string, maxLength: number): string {
  return redactSecrets(value.slice(0, maxLength)).text
}

export function buildSmartOrganizationPrompt(
  sessions: readonly SmartOrganizerSession[],
  existingFolders: readonly string[]
): { systemPrompt: string; userPrompt: string } {
  const payload = {
    existingFolders: existingFolders.map((folder) => folder.slice(0, 160)),
    sessions: sessions.map((session) => ({
      sessionId: session.sessionId,
      title: redactedSnippet(session.title, 160),
      summary: redactedSnippet(session.summary, 320)
    }))
  }

  return {
    systemPrompt: [
      '你是本地 AI 会话库的分类器。',
      '优先复用现有文件夹；确有必要才提出一到两层的新文件夹。',
      '只根据给定标题和短摘要分类，不索取或推测完整对话。',
      '返回严格 JSON 数组，不要 Markdown。',
      '每项格式：{"sessionId":"...","folder":"父/子","topic":"简短话题","tags":["标签"],"confidence":0.0}。',
      'tags 最多 6 个，confidence 范围 0 到 1。'
    ].join('\n'),
    userPrompt: JSON.stringify(payload, null, 2)
  }
}

function extractJsonArray(raw: string): unknown[] {
  const start = raw.indexOf('[')
  const end = raw.lastIndexOf(']')
  if (start < 0 || end <= start) throw new Error('智能整理没有返回 JSON 数组')
  const parsed: unknown = JSON.parse(raw.slice(start, end + 1))
  if (!Array.isArray(parsed)) throw new Error('智能整理结果格式无效')
  return parsed
}

export function parseSmartOrganizationResponse(
  raw: string,
  allowedSessionIds: ReadonlySet<string>
): SmartOrganizationSuggestion[] {
  const rows = extractJsonArray(raw)
  const suggestions: SmartOrganizationSuggestion[] = []
  const seen = new Set<string>()
  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue
    const value = row as Record<string, unknown>
    if (typeof value.sessionId !== 'string' || !allowedSessionIds.has(value.sessionId) || seen.has(value.sessionId)) continue
    if (typeof value.folder !== 'string' || typeof value.topic !== 'string') continue
    let folder: string
    try { folder = sanitizeRelativeFolder(value.folder) } catch { continue }
    const tags = Array.isArray(value.tags)
      ? [...new Set(value.tags.filter((tag): tag is string => typeof tag === 'string')
        .map((tag) => tag.trim()).filter(Boolean))].slice(0, 6)
      : []
    const confidence = typeof value.confidence === 'number' && Number.isFinite(value.confidence)
      ? Math.max(0, Math.min(1, value.confidence))
      : 0
    suggestions.push({
      sessionId: value.sessionId,
      folder,
      topic: value.topic.trim().slice(0, 120),
      tags,
      confidence
    })
    seen.add(value.sessionId)
  }
  return suggestions
}

export async function requestSmartOrganization(
  settings: LlmSettings,
  sessions: readonly SmartOrganizerSession[],
  existingFolders: readonly string[],
  caller: LlmCaller = callLlm
): Promise<SmartOrganizationSuggestion[]> {
  if (sessions.length === 0) return []
  const prompt = buildSmartOrganizationPrompt(sessions, existingFolders)
  const raw = await caller(settings, prompt.systemPrompt, prompt.userPrompt, 4096)
  return parseSmartOrganizationResponse(raw, new Set(sessions.map((session) => session.sessionId)))
}
