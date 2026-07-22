import { useEffect, useState } from 'react'
import { AlertCircle, Check } from 'lucide-react'
import { useT } from '../i18n'

export interface PlatformCapabilities {
  platform: string
  windowsNativeAlpha: boolean
  supportedSources: string[]
  unsupportedSources: string[]
  features: {
    wsl: boolean
    cloudPlaceholders: boolean
    cliInstall: boolean
    arm64: boolean
    autoUpdate: boolean
    codeSigning: boolean
  }
}

export function usePlatformCapabilities(): PlatformCapabilities | null {
  const [capabilities, setCapabilities] = useState<PlatformCapabilities | null>(null)

  useEffect(() => {
    let disposed = false
    const loadCapabilities = window.api.platformGetCapabilities
    if (!loadCapabilities) return () => { disposed = true }
    loadCapabilities()
      .then((value) => {
        if (!disposed) setCapabilities(value)
      })
      .catch(() => {
        // Older preload during hot reload: retain the existing macOS UI.
      })
    return () => { disposed = true }
  }, [])

  return capabilities
}

export function WindowsAlphaNotice({ capabilities }: { capabilities: PlatformCapabilities | null }) {
  const t = useT()
  if (!capabilities?.windowsNativeAlpha) return null

  return (
    <section
      data-testid="windows-alpha-notice"
      className="rounded-lg border border-soft-amber/30 bg-soft-amber/8 p-3"
    >
      <div className="mb-2 flex items-center gap-2 text-xs font-medium text-soft-amber">
        <AlertCircle size={13} />
        Windows Native Alpha
      </div>
      <div className="space-y-1.5 text-[11px] leading-relaxed">
        <p className="flex items-start gap-1.5 text-secondary">
          <Check size={11} className="mt-0.5 shrink-0 text-soft-green" />
          <span>{t('renderer.windows_alpha.supported')}</span>
        </p>
        <p className="text-muted">
          {t('renderer.windows_alpha.unsupported')}
        </p>
        <p className="text-muted">
          {t('renderer.windows_alpha.boundary')}
        </p>
        <p className="text-muted">{t('renderer.windows_alpha.remote')}</p>
      </div>
    </section>
  )
}
