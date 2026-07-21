/**
 * Minimal LLM client for insights narrative generation.
 * Supports Anthropic / OpenAI-compatible APIs via fetch, no SDK dependency.
 * API keys live in library config (local disk), never logged.
 */

export interface LlmSettings {
  provider: 'anthropic' | 'openai' | 'custom'
  apiKey: string
  model?: string
  baseUrl?: string
}

const DEFAULT_MODELS: Record<string, string> = {
  anthropic: 'claude-haiku-4-5-20251001',
  openai: 'gpt-4o-mini',
  custom: ''
}

export function resolveLlmModel(settings: LlmSettings): string {
  return settings.model?.trim() || DEFAULT_MODELS[settings.provider] || ''
}

export async function callLlm(
  settings: LlmSettings,
  systemPrompt: string,
  userPrompt: string,
  maxTokens = 4096
): Promise<string> {
  const model = resolveLlmModel(settings)
  if (!settings.apiKey?.trim()) throw new Error('missing-api-key')
  if (!model) throw new Error('missing-model')

  if (settings.provider === 'anthropic') {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': settings.apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }]
      })
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`anthropic-${res.status}: ${body.slice(0, 200)}`)
    }
    const data = await res.json()
    const parts = Array.isArray(data.content) ? data.content : []
    return parts.filter((p: { type: string }) => p.type === 'text').map((p: { text: string }) => p.text).join('\n')
  }

  // OpenAI-compatible (openai / custom baseUrl)
  const baseUrl = (settings.provider === 'custom' && settings.baseUrl?.trim())
    ? settings.baseUrl.trim().replace(/\/+$/, '')
    : 'https://api.openai.com/v1'
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${settings.apiKey}`
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ]
    })
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`llm-${res.status}: ${body.slice(0, 200)}`)
  }
  const data = await res.json()
  return data.choices?.[0]?.message?.content || ''
}
