/**
 * Minimal LLM client for insights narrative generation.
 * Supports Anthropic / OpenAI-compatible APIs via fetch, no SDK dependency.
 * Credentials are supplied at call time from the OS secret store and are never logged.
 */

export interface LlmSettings {
  provider: 'anthropic' | 'openai' | 'custom'
  credential: string
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
  if (!settings.credential?.trim()) throw new Error('missing-api-key')
  if (!model) throw new Error('missing-model')

  // Determine if this is an Anthropic-protocol endpoint
  const isAnthropicProtocol = settings.provider === 'anthropic' ||
    (settings.provider === 'custom' && settings.baseUrl?.includes('anthropic'))

  if (isAnthropicProtocol) {
    const endpoint = settings.provider === 'anthropic'
      ? 'https://api.anthropic.com/v1/messages'
      : `${settings.baseUrl!.trim().replace(/\/+$/, '')}/v1/messages`
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': settings.credential,
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
      authorization: `Bearer ${settings.credential}`
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

/** Fetch available models from the configured provider. Returns model IDs sorted by recommendation. */
export async function listModels(settings: LlmSettings): Promise<string[]> {
  if (!settings.credential?.trim()) return []

  const isAnthropicProtocol = settings.provider === 'anthropic' ||
    (settings.provider === 'custom' && settings.baseUrl?.includes('anthropic'))

  try {
    if (isAnthropicProtocol) {
      const endpoint = settings.provider === 'anthropic'
        ? 'https://api.anthropic.com/v1/models'
        : `${settings.baseUrl!.trim().replace(/\/+$/, '')}/v1/models`
      const res = await fetch(endpoint, {
        headers: { 'x-api-key': settings.credential, 'anthropic-version': '2023-06-01' },
        signal: AbortSignal.timeout(10_000)
      })
      if (!res.ok) return []
      const data = await res.json()
      const models = (Array.isArray(data.data) ? data.data : [])
        .map((m: { id: string }) => m.id)
        .filter((id: string) => id.startsWith('claude'))
      // Sort: haiku first (cheapest), then sonnet, then opus
      const order = (id: string) => id.includes('haiku') ? 0 : id.includes('sonnet') ? 1 : id.includes('opus') ? 2 : 3
      return models.sort((a: string, b: string) => order(a) - order(b) || b.localeCompare(a))
    }

    // OpenAI-compatible
    const baseUrl = (settings.provider === 'custom' && settings.baseUrl?.trim())
      ? settings.baseUrl.trim().replace(/\/+$/, '')
      : 'https://api.openai.com/v1'
    const res = await fetch(`${baseUrl}/models`, {
      headers: { authorization: `Bearer ${settings.credential}` },
      signal: AbortSignal.timeout(10_000)
    })
    if (!res.ok) return []
    const data = await res.json()
    const models = (Array.isArray(data.data) ? data.data : [])
      .map((m: { id: string }) => m.id)
      .filter((id: string) => !id.includes('embed') && !id.includes('tts') && !id.includes('whisper') && !id.includes('dall-e'))
      .sort((a: { created?: number }, b: { created?: number }) => (b.created || 0) - (a.created || 0))
    return models
  } catch {
    return []
  }
}
