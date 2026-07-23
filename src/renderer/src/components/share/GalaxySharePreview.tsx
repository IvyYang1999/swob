/**
 * GalaxySharePreview — modal for previewing and exporting the Galaxy share image.
 *
 * Reuses the copy/save IPC patterns from tF10's SharePreview but with a
 * simpler single-page layout (Galaxy image is always one page).
 */

import { useState, useEffect, useCallback } from 'react'
import { X, Copy, Download, Check, Image } from 'lucide-react'
import { useT } from '../../i18n'
import { renderGalaxyShareImage, type GalaxyNode, type GalaxyShareOptions } from './GalaxyShareRenderer'
import { dataUrlToBase64 } from './ShareRenderer'
import { useStore } from '../../store'

interface GalaxySharePreviewProps {
  nodes: readonly GalaxyNode[]
  sourceColors: Readonly<Record<string, string>>
  sourceLabels: Readonly<Record<string, string>>
  onClose: () => void
}

export function GalaxySharePreview({
  nodes,
  sourceColors,
  sourceLabels,
  onClose,
}: GalaxySharePreviewProps) {
  const t = useT()
  const locale = useStore((s) => s.locale)
  const theme = useStore((s) => s.theme)
  const colorScheme = useStore((s) => s.colorScheme)
  const isDark = theme === 'dark'

  // Freeze nodes snapshot on mount — parent re-renders produce new array refs
  // but the share image must stay stable for the entire modal lifecycle.
  // A new snapshot is created automatically on the next open (remount).
  const [frozenNodes] = useState<readonly GalaxyNode[]>(() => nodes)

  const [imageUrl, setImageUrl] = useState<string | null>(null)
  const [rendering, setRendering] = useState(true)
  const [renderError, setRenderError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [saved, setSaved] = useState(false)

  // Render on mount / when theme changes
  useEffect(() => {
    let cancelled = false
    setRendering(true)
    setRenderError(null)

    const options: GalaxyShareOptions = {
      nodes: frozenNodes,
      sourceColors,
      sourceLabels,
      locale,
      isDark,
      colorScheme,
    }

    renderGalaxyShareImage(options)
      .then((dataUrl) => {
        if (cancelled) return
        setImageUrl(dataUrl)
        setRendering(false)
      })
      .catch((err) => {
        if (cancelled) return
        setRenderError(String(err?.message || err))
        setRendering(false)
      })

    return () => { cancelled = true }
  }, [frozenNodes, sourceColors, sourceLabels, locale, isDark, colorScheme])

  const handleCopy = useCallback(async () => {
    if (!imageUrl) return
    try {
      const base64 = dataUrlToBase64(imageUrl)
      const api = (window as any).api
      if (api?.shareCopyPngToClipboard) {
        await api.shareCopyPngToClipboard(base64)
      } else {
        const response = await fetch(imageUrl)
        const blob = await response.blob()
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
      }
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch (err) {
      console.error('Failed to copy Galaxy PNG:', err)
    }
  }, [imageUrl])

  const handleSave = useCallback(async () => {
    if (!imageUrl) return
    try {
      const base64 = dataUrlToBase64(imageUrl)
      const api = (window as any).api
      const date = new Date().toISOString().slice(0, 10)
      const suggestedName = `swob-galaxy-${date}.png`

      if (api?.shareSavePng) {
        const result = await api.shareSavePng(base64, suggestedName)
        if (result?.ok !== false && !result?.canceled) {
          setSaved(true)
          setTimeout(() => setSaved(false), 2000)
        }
      } else {
        const a = document.createElement('a')
        a.href = imageUrl
        a.download = suggestedName
        a.click()
        setSaved(true)
        setTimeout(() => setSaved(false), 2000)
      }
    } catch (err) {
      console.error('Failed to save Galaxy PNG:', err)
    }
  }, [imageUrl])

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  return (
    <div
      className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="bg-base border border-edge rounded-xl shadow-2xl max-w-[860px] w-full max-h-[90vh] flex flex-col mx-4">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-edge-subtle">
          <div className="flex items-center gap-2">
            <Image size={16} className="text-soft-blue" />
            <span className="text-sm font-medium text-primary">
              {t('galaxy.share_button')}
            </span>
          </div>
          <button
            onClick={onClose}
            aria-label={t('chat.close')}
            className="p-1 rounded hover:bg-hover text-muted hover:text-body transition-colors"
          >
            <X size={16} />
          </button>
        </div>

        {/* Body — preview */}
        <div className="flex-1 min-h-0 p-4 overflow-auto bg-surface/30 flex items-start justify-center">
          {rendering ? (
            <div className="flex items-center gap-2 text-sm text-muted py-20">
              <div className="w-4 h-4 border-2 border-soft-blue/30 border-t-soft-blue rounded-full animate-spin" />
              {t('share.rendering')}
            </div>
          ) : renderError ? (
            <div className="text-sm text-soft-red py-20 text-center">
              {t('share.render_error')}
              <div className="text-[11px] text-muted mt-1">{renderError}</div>
            </div>
          ) : imageUrl ? (
            <img
              src={imageUrl}
              alt={t('galaxy.share_preview_alt')}
              className="max-w-full rounded-lg shadow-lg"
              style={{ imageRendering: 'auto' }}
            />
          ) : null}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-edge-subtle">
          <button
            onClick={onClose}
            className="px-3 py-1.5 text-xs rounded-md text-secondary hover:text-body hover:bg-hover transition-colors"
          >
            {t('chat.close')}
          </button>
          <button
            onClick={handleCopy}
            disabled={rendering || !imageUrl}
            className="px-3 py-1.5 text-xs rounded-md bg-soft-blue/12 text-soft-blue hover:bg-soft-blue/18 flex items-center gap-1.5 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            {copied ? <Check size={12} className="text-soft-green" /> : <Copy size={12} />}
            {copied ? t('chat.copied') : t('share.copy_png')}
          </button>
          <button
            onClick={handleSave}
            disabled={rendering || !imageUrl}
            className="px-3 py-1.5 text-xs rounded-md bg-soft-blue text-white hover:bg-soft-blue/90 flex items-center gap-1.5 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            {saved ? <Check size={12} /> : <Download size={12} />}
            {saved ? t('share.saved') : t('share.save_png')}
          </button>
        </div>
      </div>
    </div>
  )
}
