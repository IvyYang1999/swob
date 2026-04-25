import type { ByModel } from './shared'
import { formatTokenCount } from './shared'

// Friendly short names for known models
function shortName(model: string): string {
  if (model.includes('opus')) return model.includes('4-6') ? 'Opus 4.6' : model.includes('4-5') ? 'Opus 4.5' : 'Opus'
  if (model.includes('sonnet')) return model.includes('4-6') ? 'Sonnet 4.6' : model.includes('4-5') ? 'Sonnet 4.5' : 'Sonnet'
  if (model.includes('haiku')) return model.includes('4-5') ? 'Haiku 4.5' : 'Haiku'
  if (model === 'gpt-5.4' || model === 'gpt-5.4-mini') return model.replace('gpt-', 'GPT-')
  if (model.startsWith('gpt-')) return model.replace('gpt-', 'GPT-').replace('-mini', ' mini')
  if (model.startsWith('o')) return model  // o1, o3, etc.
  if (model.includes('kimi')) return 'Kimi'
  return model.length > 20 ? model.slice(0, 18) + '…' : model
}

function modelColor(model: string): string {
  if (model.includes('opus')) return 'bg-purple-500'
  if (model.includes('sonnet')) return 'bg-blue-500'
  if (model.includes('haiku')) return 'bg-cyan-500'
  if (model.includes('gpt') || model.includes('GPT')) return 'bg-emerald-500'
  if (model.startsWith('o1') || model.startsWith('o3')) return 'bg-orange-500'
  if (model.includes('kimi')) return 'bg-pink-500'
  return 'bg-zinc-400'
}

export function ModelBreakdown({ models }: { models: ByModel[] }) {
  if (models.length === 0) {
    return <div className="text-xs text-faint py-4 text-center">No model data</div>
  }

  const maxTokens = models[0].totalTokens

  return (
    <div className="space-y-2">
      {models.map((m) => {
        const pct = maxTokens > 0 ? (m.totalTokens / maxTokens) * 100 : 0
        const color = modelColor(m.model)
        return (
          <div key={m.model} className="space-y-0.5">
            <div className="flex items-center justify-between text-xs">
              <span className="text-primary font-medium">{shortName(m.model)}</span>
              <span className="text-muted">{formatTokenCount(m.totalTokens)}</span>
            </div>
            <div className="h-1.5 bg-edge rounded-full overflow-hidden">
              <div
                className={`h-full rounded-full ${color}`}
                style={{ width: `${pct}%` }}
              />
            </div>
            <div className="text-[10px] text-faint">{m.sessionCount} sessions</div>
          </div>
        )
      })}
    </div>
  )
}
