/**
 * GalaxyShareRenderer — renders the Galaxy star map as a share image.
 *
 * Produces a 2x-resolution PNG via offscreen canvas:
 *   - Star field background with subtle dot pattern
 *   - All graph nodes drawn at their layout positions, colored by source
 *   - Stats panel: sessions, turns, sources, longest session
 *   - Legend: source color dots + names (only present sources)
 *   - Brand area: "Swob" text + tagline + QR code
 *
 * Privacy: no paths, no titles, no content — only anonymous dots + aggregate numbers.
 */

import QRCode from 'qrcode'
import type { Locale } from '../../../../shared/i18n'
import { translate } from '../../../../shared/i18n'

const SHARE_QR_URL = 'https://github.com/IvyYang1999/swob/releases'

/** Minimal node data needed for rendering. */
export interface GalaxyNode {
  x: number
  y: number
  source: string
  turnCount: number
  recency: number
  totalTokens: number
  compactCount: number
}

export interface GalaxyShareOptions {
  nodes: readonly GalaxyNode[]
  sourceColors: Readonly<Record<string, string>>
  sourceLabels: Readonly<Record<string, string>>
  locale: Locale
  isDark: boolean
}

// Canvas dimensions (logical pixels, rendered at 2x)
const CANVAS_W = 800
const CANVAS_H = 600
const PADDING = 40
const STATS_H = 120
const GRAPH_AREA_H = CANVAS_H - STATS_H - PADDING

/**
 * Generate a QR code as a data URL (PNG).
 * Falls back to an empty string on error — the image renders without QR.
 */
async function generateQrDataUrl(url: string, isDark: boolean): Promise<string> {
  try {
    return await QRCode.toDataURL(url, {
      errorCorrectionLevel: 'M',
      width: 160, // 80 logical * 2x
      margin: 1,
      color: {
        dark: isDark ? '#e4e4e7' : '#1a1a2e',
        light: '#00000000', // transparent
      },
    })
  } catch {
    return ''
  }
}

/**
 * Draw subtle star dots on the background.
 */
function drawStarField(ctx: CanvasRenderingContext2D, w: number, h: number, isDark: boolean): void {
  const starColor = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.04)'
  // Use a deterministic seeded pattern based on grid + offset
  const spacing = 18
  for (let x = 0; x < w; x += spacing) {
    for (let y = 0; y < h; y += spacing) {
      // Simple hash for deterministic variation
      const hash = ((x * 7 + y * 13) % 100)
      if (hash > 40) continue // ~60% of cells have no star
      const ox = (hash * 3) % spacing
      const oy = (hash * 7) % spacing
      const size = 0.4 + (hash % 3) * 0.3
      ctx.fillStyle = starColor
      ctx.beginPath()
      ctx.arc(x + ox, y + oy, size, 0, Math.PI * 2)
      ctx.fill()
    }
  }
}

/**
 * Compute bounding box and scale factor to fit all nodes into the graph area.
 */
function computeTransform(nodes: readonly GalaxyNode[]): {
  offsetX: number; offsetY: number; scale: number
} {
  if (nodes.length === 0) return { offsetX: CANVAS_W / 2, offsetY: GRAPH_AREA_H / 2, scale: 1 }

  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
  for (const n of nodes) {
    if (n.x < minX) minX = n.x
    if (n.x > maxX) maxX = n.x
    if (n.y < minY) minY = n.y
    if (n.y > maxY) maxY = n.y
  }

  const bboxW = maxX - minX || 1
  const bboxH = maxY - minY || 1
  const centerX = (minX + maxX) / 2
  const centerY = (minY + maxY) / 2

  const areaW = CANVAS_W - PADDING * 2
  const areaH = GRAPH_AREA_H - PADDING
  const scale = Math.min(2, areaW * 0.85 / bboxW, areaH * 0.85 / bboxH)

  return {
    offsetX: CANVAS_W / 2 - centerX * scale,
    offsetY: PADDING + GRAPH_AREA_H / 2 - centerY * scale,
    scale,
  }
}

/**
 * Collect stats from nodes.
 */
function computeStats(nodes: readonly GalaxyNode[]): {
  totalSessions: number
  totalTurns: number
  sourceCount: number
  longestTurns: number
  presentSources: string[]
} {
  const sourceSet = new Set<string>()
  let totalTurns = 0
  let longestTurns = 0

  for (const n of nodes) {
    sourceSet.add(n.source)
    totalTurns += n.turnCount
    if (n.turnCount > longestTurns) longestTurns = n.turnCount
  }

  return {
    totalSessions: nodes.length,
    totalTurns,
    sourceCount: sourceSet.size,
    longestTurns,
    presentSources: [...sourceSet],
  }
}

/**
 * Main entry: render the Galaxy share image and return a PNG data URL.
 */
export async function renderGalaxyShareImage(options: GalaxyShareOptions): Promise<string> {
  const { nodes, sourceColors, sourceLabels, locale, isDark } = options
  const scale = 2 // retina

  const canvas = document.createElement('canvas')
  canvas.width = CANVAS_W * scale
  canvas.height = CANVAS_H * scale
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Canvas context unavailable')
  ctx.scale(scale, scale)

  // Background
  const bgColor = isDark ? '#0d1117' : '#f8f9fa'
  ctx.fillStyle = bgColor
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H)

  // Star field
  drawStarField(ctx, CANVAS_W, CANVAS_H, isDark)

  // Draw nodes
  const transform = computeTransform(nodes)
  for (const node of nodes) {
    const px = node.x * transform.scale + transform.offsetX
    const py = node.y * transform.scale + transform.offsetY

    const color = sourceColors[node.source] || '#94a3b8'
    const turnSize = Math.sqrt(node.turnCount) * 0.25
    const tokenBoost = Math.min(1.5, node.totalTokens / 300000)
    const compactBoost = Math.min(1, node.compactCount * 0.3)
    const size = Math.max(1.5, Math.min(6, turnSize + tokenBoost + compactBoost))

    const baseAlpha = 0.3 + node.recency * 0.6
    ctx.globalAlpha = baseAlpha
    ctx.fillStyle = color
    ctx.beginPath()
    ctx.arc(px, py, size, 0, Math.PI * 2)
    ctx.fill()
  }
  ctx.globalAlpha = 1

  // Stats & brand area
  const statsY = CANVAS_H - STATS_H
  const dividerColor = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)'
  ctx.fillStyle = dividerColor
  ctx.fillRect(PADDING, statsY, CANVAS_W - PADDING * 2, 1)

  const stats = computeStats(nodes)
  const textColor = isDark ? '#e4e4e7' : '#1a1a2e'
  const mutedColor = isDark ? '#71717a' : '#8a8a9e'

  // Stats row
  const statsRowY = statsY + 28
  const statItems = [
    { value: String(stats.totalSessions), label: translate(locale, 'galaxy.stat_sessions') },
    { value: String(stats.totalTurns), label: translate(locale, 'galaxy.stat_turns') },
    { value: String(stats.sourceCount), label: translate(locale, 'galaxy.stat_sources') },
    { value: String(stats.longestTurns), label: translate(locale, 'galaxy.stat_longest') },
  ]

  const statColW = 100
  const statsStartX = PADDING
  ctx.textAlign = 'left'
  for (let i = 0; i < statItems.length; i++) {
    const sx = statsStartX + i * statColW
    ctx.font = 'bold 20px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    ctx.fillStyle = textColor
    ctx.fillText(statItems[i].value, sx, statsRowY)
    ctx.font = '11px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    ctx.fillStyle = mutedColor
    ctx.fillText(statItems[i].label, sx, statsRowY + 18)
  }

  // Legend row — only present sources
  const legendY = statsRowY + 42
  let legendX = PADDING
  ctx.font = '11px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
  for (const src of stats.presentSources) {
    const color = sourceColors[src] || '#94a3b8'
    const label = sourceLabels[src] || src

    // Dot
    ctx.fillStyle = color
    ctx.beginPath()
    ctx.arc(legendX + 5, legendY, 4, 0, Math.PI * 2)
    ctx.fill()

    // Label
    ctx.fillStyle = mutedColor
    ctx.fillText(label, legendX + 14, legendY + 4)
    legendX += ctx.measureText(label).width + 28
  }

  // Brand area — right side
  const brandX = CANVAS_W - PADDING
  const brandY = statsRowY

  // QR code
  const qrDataUrl = await generateQrDataUrl(SHARE_QR_URL, isDark)
  const qrSize = 64
  const qrX = brandX - qrSize
  const qrY = statsY + 14

  if (qrDataUrl) {
    const qrImg = await loadImage(qrDataUrl)
    ctx.drawImage(qrImg, qrX, qrY, qrSize, qrSize)
  }

  // Swob text to the left of QR
  const brandTextX = qrX - 12
  ctx.textAlign = 'right'
  ctx.font = 'bold 16px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
  ctx.fillStyle = textColor
  ctx.fillText('Swob', brandTextX, brandY + 4)

  // Tagline
  ctx.font = '10px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
  ctx.fillStyle = mutedColor
  const tagline = translate(locale, 'galaxy.share_tagline')
  ctx.fillText(tagline, brandTextX, brandY + 20)

  ctx.textAlign = 'left'

  return canvas.toDataURL('image/png')
}

/** Load an image from a data URL. */
function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('Failed to load image'))
    img.src = src
  })
}
