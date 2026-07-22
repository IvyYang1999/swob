import { useEffect, useState } from 'react'
import { AlertCircle, Check } from 'lucide-react'

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
          <span>已支持：Claude Code、Codex 的浏览、搜索、备份、Resume 与本地 Library。</span>
        </p>
        <p className="text-muted">
          暂不支持：Cursor、OpenCode、ZCode、CC-Mirror、Antigravity、Grok、Pi、Kimi、Hermes。
        </p>
        <p className="text-muted">
          Alpha 边界：不含 WSL、OneDrive 占位文件、Windows CLI 安装、ARM64、自动更新和代码签名。
        </p>
        <p className="text-muted">远程入口：SSH 与手机连接暂不在 Windows Native Alpha 开放。</p>
      </div>
    </section>
  )
}
