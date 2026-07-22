/**
 * SharePreview — modal component for previewing and exporting share images.
 *
 * Features:
 * - Preview the rendered share image
 * - Copy PNG to clipboard
 * - Save PNG to file (via IPC)
 * - Theme selector (Light / Dark / Minimal)
 * - Watermark toggle ("via Swob", default on)
 * - Privacy toggles (session ID, paths — default off for inclusion)
 * - Auto-pagination if content > 3000px height
 * - Secret pattern warning before export
 */

import { useState, useEffect, useCallback, useMemo } from 'react'
import { X, Copy, Download, Check, AlertTriangle, Image } from 'lucide-react'
import { useT } from '../../i18n'
import { SHARE_THEMES, getThemeById } from './share-themes'
import type { ShareTheme } from './share-themes'
import { DEFAULT_PRIVACY, detectSecrets } from './privacy-utils'
import type { PrivacyOptions } from './privacy-utils'
import { renderShareImage, dataUrlToBase64 } from './ShareRenderer'
import type { ShareMessage } from './ShareRenderer'

interface SharePreviewProps {
  messages: ShareMessage[]
  sessionSource?: string
  userDisplayName?: string
  onClose: () => void
}

export function SharePreview({ messages, sessionSource, userDisplayName, onClose }: SharePreviewProps) {
  const t = useT()

  // Theme state
  const [themeId, setThemeId] = useState<ShareTheme['id']>('light')
  const theme = useMemo(() => getThemeById(themeId), [themeId])

  // Watermark state (default ON)
  const [showWatermark, setShowWatermark] = useState(true)

  // Privacy state (privacy-first defaults: all stripping ON)
  const [privacy, setPrivacy] = useState<PrivacyOptions>({ ...DEFAULT_PRIVACY })

  // Rendered images
  const [images, setImages] = useState<string[]>([])
  const [currentPage, setCurrentPage] = useState(0)
  const [rendering, setRendering] = useState(false)
  const [renderError, setRenderError] = useState<string | null>(null)

  // Copy/save state
  const [copied, setCopied] = useState(false)
  const [saved, setSaved] = useState(false)

  // Secret detection
  const secretWarnings = useMemo(() => {
    const allText = messages.map((m) => m.text).join('\n')
    return detectSecrets(allText)
  }, [messages])

  // Re-render when settings change
  useEffect(() => {
    let cancelled = false
    setRendering(true)
    setRenderError(null)

    renderShareImage({
      messages,
      theme,
      showWatermark,
      privacy,
      sessionSource,
      userDisplayName,
    })
      .then((results) => {
        if (cancelled) return
        setImages(results)
        setCurrentPage(0)
        setRendering(false)
      })
      .catch((err) => {
        if (cancelled) return
        setRenderError(String(err?.message || err))
        setRendering(false)
      })

    return () => {
      cancelled = true
    }
  }, [messages, theme, showWatermark, privacy, sessionSource, userDisplayName])

  const handleCopy = useCallback(async () => {
    const dataUrl = images[currentPage]
    if (!dataUrl) return

    try {
      const base64 = dataUrlToBase64(dataUrl)
      const api = (window as any).api
      if (api?.shareCopyPngToClipboard) {
        await api.shareCopyPngToClipboard(base64)
      } else {
        // Fallback: use browser clipboard API
        const response = await fetch(dataUrl)
        const blob = await response.blob()
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
      }
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch (err) {
      console.error('Failed to copy PNG:', err)
    }
  }, [images, currentPage])

  const handleSave = useCallback(async () => {
    const dataUrl = images[currentPage]
    if (!dataUrl) return

    try {
      const base64 = dataUrlToBase64(dataUrl)
      const api = (window as any).api
      const date = new Date().toISOString().slice(0, 10)
      const pageLabel = images.length > 1 ? `-p${currentPage + 1}` : ''
      const suggestedName = `swob-share-${date}${pageLabel}.png`

      if (api?.shareSavePng) {
        const result = await api.shareSavePng(base64, suggestedName)
        if (result?.ok !== false && !result?.canceled) {
          setSaved(true)
          setTimeout(() => setSaved(false), 2000)
        }
      } else {
        // Fallback: browser download
        const a = document.createElement('a')
        a.href = dataUrl
        a.download = suggestedName
        a.click()
        setSaved(true)
        setTimeout(() => setSaved(false), 2000)
      }
    } catch (err) {
      console.error('Failed to save PNG:', err)
    }
  }, [images, currentPage])

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  const togglePrivacy = useCallback((key: keyof PrivacyOptions) => {
    setPrivacy((prev) => ({ ...prev, [key]: !prev[key] }))
  }, [])

  return (
    <div
      className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="bg-base border border-edge rounded-xl shadow-2xl max-w-[820px] w-full max-h-[90vh] flex flex-col mx-4">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-edge-subtle">
          <div className="flex items-center gap-2">
            <Image size={16} className="text-soft-blue" />
            <span className="text-sm font-medium text-primary">{t('share.title')}</span>
            {images.length > 1 && (
              <span className="text-[10px] text-muted px-1.5 py-0.5 rounded bg-surface">
                {t('share.page_of', { current: currentPage + 1, total: images.length })}
              </span>
            )}
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded hover:bg-hover text-muted hover:text-body transition-colors"
          >
            <X size={16} />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 min-h-0 flex overflow-hidden">
          {/* Preview area */}
          <div className="flex-1 min-w-0 p-4 overflow-auto bg-surface/30 flex items-start justify-center">
            {rendering ? (
              <div className="flex items-center gap-2 text-sm text-muted py-20">
                <div className="w-4 h-4 border-2 border-soft-blue/30 border-t-soft-blue rounded-full animate-spin" />
                {t('share.rendering')}
              </div>
            ) : renderError ? (
              <div className="text-sm text-soft-red py-20 text-center">
                <AlertTriangle size={20} className="mx-auto mb-2" />
                {t('share.render_error')}
                <div className="text-[11px] text-muted mt-1">{renderError}</div>
              </div>
            ) : images[currentPage] ? (
              <img
                src={images[currentPage]}
                alt="Share preview"
                className="max-w-full rounded-lg shadow-lg"
                style={{ imageRendering: 'auto' }}
              />
            ) : null}
          </div>

          {/* Sidebar controls */}
          <div className="w-52 shrink-0 border-l border-edge-subtle p-3 overflow-y-auto space-y-4">
            {/* Theme selector */}
            <div>
              <div className="text-[11px] text-muted font-medium uppercase tracking-wide mb-2">
                {t('share.theme')}
              </div>
              <div className="space-y-1">
                {SHARE_THEMES.map((th) => (
                  <button
                    key={th.id}
                    onClick={() => setThemeId(th.id)}
                    className={`w-full flex items-center gap-2 px-2.5 py-1.5 rounded-md text-xs transition-colors ${
                      themeId === th.id
                        ? 'bg-soft-blue/12 text-soft-blue border border-soft-blue/25'
                        : 'text-secondary hover:text-body hover:bg-hover/50 border border-transparent'
                    }`}
                  >
                    <div
                      className="w-4 h-4 rounded border border-edge-strong"
                      style={{ background: th.vars.bg }}
                    />
                    <span>{th.label}</span>
                  </button>
                ))}
              </div>
            </div>

            {/* Watermark */}
            <div>
              <div className="text-[11px] text-muted font-medium uppercase tracking-wide mb-2">
                {t('share.watermark')}
              </div>
              <label className="flex items-center gap-2 text-xs text-secondary cursor-pointer">
                <input
                  type="checkbox"
                  checked={showWatermark}
                  onChange={() => setShowWatermark(!showWatermark)}
                  className="rounded"
                />
                <span>&quot;via Swob&quot;</span>
              </label>
            </div>

            {/* Privacy */}
            <div>
              <div className="text-[11px] text-muted font-medium uppercase tracking-wide mb-2">
                {t('share.privacy')}
              </div>
              <div className="space-y-1.5">
                <label className="flex items-center gap-2 text-xs text-secondary cursor-pointer">
                  <input
                    type="checkbox"
                    checked={privacy.stripPaths}
                    onChange={() => togglePrivacy('stripPaths')}
                    className="rounded"
                  />
                  <span>{t('share.strip_paths')}</span>
                </label>
                <label className="flex items-center gap-2 text-xs text-secondary cursor-pointer">
                  <input
                    type="checkbox"
                    checked={privacy.stripSessionIds}
                    onChange={() => togglePrivacy('stripSessionIds')}
                    className="rounded"
                  />
                  <span>{t('share.strip_session_ids')}</span>
                </label>
                <label className="flex items-center gap-2 text-xs text-secondary cursor-pointer">
                  <input
                    type="checkbox"
                    checked={privacy.excludeToolResults}
                    onChange={() => togglePrivacy('excludeToolResults')}
                    className="rounded"
                  />
                  <span>{t('share.exclude_tool_results')}</span>
                </label>
              </div>
            </div>

            {/* Secret warning */}
            {secretWarnings.length > 0 && (
              <div className="p-2 rounded-md bg-soft-amber/8 border border-soft-amber/20">
                <div className="flex items-center gap-1.5 text-[11px] text-soft-amber font-medium mb-1">
                  <AlertTriangle size={12} />
                  {t('share.secret_warning')}
                </div>
                <div className="text-[10px] text-soft-amber/70 leading-relaxed">
                  {t('share.secret_warning_detail')}
                </div>
              </div>
            )}

            {/* Pagination controls */}
            {images.length > 1 && (
              <div>
                <div className="text-[11px] text-muted font-medium uppercase tracking-wide mb-2">
                  {t('share.pages')}
                </div>
                <div className="flex items-center gap-1">
                  {images.map((_, idx) => (
                    <button
                      key={idx}
                      onClick={() => setCurrentPage(idx)}
                      className={`w-7 h-7 rounded text-[11px] font-medium transition-colors ${
                        currentPage === idx
                          ? 'bg-soft-blue/15 text-soft-blue'
                          : 'text-muted hover:text-body hover:bg-hover'
                      }`}
                    >
                      {idx + 1}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
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
            disabled={rendering || images.length === 0}
            className="px-3 py-1.5 text-xs rounded-md bg-soft-blue/12 text-soft-blue hover:bg-soft-blue/18 flex items-center gap-1.5 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            {copied ? <Check size={12} className="text-soft-green" /> : <Copy size={12} />}
            {copied ? t('chat.copied') : t('share.copy_png')}
          </button>
          <button
            onClick={handleSave}
            disabled={rendering || images.length === 0}
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
