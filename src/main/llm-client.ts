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

export interface LlmCallOptions {
  signal?: AbortSignal
  connectTimeoutMs?: number
  totalTimeoutMs?: number
}

export class LlmRequestError extends Error {
  readonly code: string

  constructor(code: string, message = code) {
    super(message)
    this.name = 'LlmRequestError'
    this.code = code
  }
}

const DEFAULT_MODELS: Record<string, string> = {
  anthropic: 'claude-haiku-4-5-20251001',
  openai: 'gpt-4o-mini',
  custom: ''
}

export function resolveLlmModel(settings: LlmSettings): string {
  return settings.model?.trim() || DEFAULT_MODELS[settings.provider] || ''
}

async function withRequestTimeout<T>(
  operation: (signal: AbortSignal, connected: () => void) => Promise<T>,
  options: LlmCallOptions
): Promise<T> {
  const controller = new AbortController()
  let abortCode = 'llm-cancelled'
  let rejectAbort!: (error: Error) => void
  const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject })
  const abort = (code: string): void => {
    if (controller.signal.aborted) return
    abortCode = code
    controller.abort()
    rejectAbort(new LlmRequestError(code))
  }
  const onParentAbort = (): void => abort('llm-cancelled')
  if (options.signal?.aborted) abort('llm-cancelled')
  else options.signal?.addEventListener('abort', onParentAbort, { once: true })

  const connectTimer = setTimeout(
    () => abort('llm-connect-timeout'),
    options.connectTimeoutMs ?? 30_000
  )
  const totalTimer = setTimeout(
    () => abort('llm-total-timeout'),
    options.totalTimeoutMs ?? 120_000
  )
  connectTimer.unref?.()
  totalTimer.unref?.()

  try {
    return await Promise.race([
      operation(controller.signal, () => clearTimeout(connectTimer)),
      aborted
    ])
  } catch (error) {
    if (controller.signal.aborted) {
      if (error instanceof LlmRequestError) throw error
      throw new LlmRequestError(abortCode)
    }
    throw error
  } finally {
    clearTimeout(connectTimer)
    clearTimeout(totalTimer)
    options.signal?.removeEventListener('abort', onParentAbort)
  }
}

export async function callLlm(
  settings: LlmSettings,
  systemPrompt: string,
  userPrompt: string,
  maxTokens = 4096,
  options: LlmCallOptions = {}
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
    return withRequestTimeout(async (signal, connected) => {
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
        }),
        signal
      })
      connected()
      if (!res.ok) throw new LlmRequestError(`anthropic-http-${res.status}`)
      const data = await res.json()
      const parts = Array.isArray(data.content) ? data.content : []
      return parts.filter((p: { type: string }) => p.type === 'text').map((p: { text: string }) => p.text).join('\n')
    }, options)
  }

  // OpenAI-compatible (openai / custom baseUrl)
  const baseUrl = (settings.provider === 'custom' && settings.baseUrl?.trim())
    ? settings.baseUrl.trim().replace(/\/+$/, '')
    : 'https://api.openai.com/v1'
  return withRequestTimeout(async (signal, connected) => {
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
      }),
      signal
    })
    connected()
    if (!res.ok) throw new LlmRequestError(`llm-http-${res.status}`)
    const data = await res.json()
    return data.choices?.[0]?.message?.content || ''
  }, options)
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
