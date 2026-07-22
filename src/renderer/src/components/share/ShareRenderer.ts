/**
 * ShareRenderer — deterministic offscreen renderer for share images.
 *
 * Takes selected messages and renders them as a clean card layout,
 * then converts to PNG via SVG foreignObject -> Canvas.
 *
 * The approach:
 * 1. Build an HTML string for the share card (no DOM mutation until render time)
 * 2. Wrap it in an SVG foreignObject
 * 3. Draw the SVG onto a canvas
 * 4. Export canvas as PNG data URL
 */

import type { ShareTheme } from './share-themes'
import type { PrivacyOptions } from './privacy-utils'
import { sanitizeText } from './privacy-utils'
import { getHarnessPresentation } from '../../utils/harness-presentation'

export interface ShareMessage {
  uuid: string
  role: 'user' | 'assistant'
  text: string
  timestamp?: string
  toolCalls?: Array<{ name: string }>
}

export interface ShareRenderOptions {
  messages: ShareMessage[]
  theme: ShareTheme
  showWatermark: boolean
  privacy: PrivacyOptions
  sessionSource?: string
  userDisplayName?: string
  /** Max height in px before pagination (default: 3000) */
  maxHeight?: number
}

const CARD_WIDTH = 640
const CARD_PADDING = 32
const MESSAGE_GAP = 20
const MAX_HEIGHT_DEFAULT = 3000

/**
 * Escape HTML special characters to prevent injection.
 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;')
}

/**
 * Convert basic markdown-like formatting to HTML for assistant messages.
 * Handles: **bold**, *italic*, `code`, ```code blocks```, line breaks
 */
function formatAssistantText(text: string): string {
  const escaped = escapeHtml(text)
  return escaped
    // Code blocks (triple backtick)
    .replace(/```(?:\w*\n)?([\s\S]*?)```/g, '<pre style="background:rgba(128,128,128,0.1);padding:8px 12px;border-radius:6px;font-family:\'SF Mono\',Monaco,monospace;font-size:12px;overflow-x:auto;margin:4px 0;white-space:pre-wrap;word-break:break-all;">$1</pre>')
    // Inline code
    .replace(/`([^`]+)`/g, '<code style="background:rgba(128,128,128,0.12);padding:1px 5px;border-radius:3px;font-family:\'SF Mono\',Monaco,monospace;font-size:12px;">$1</code>')
    // Bold
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    // Italic
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    // Line breaks
    .replace(/\n/g, '<br/>')
}

/**
 * Build the HTML content for a single message card.
 */
function buildMessageHtml(
  msg: ShareMessage,
  theme: ShareTheme,
  privacy: PrivacyOptions,
  sessionSource?: string,
  userDisplayName?: string,
): string {
  const isUser = msg.role === 'user'
  const roleColor = isUser ? theme.vars.userAccent : theme.vars.assistantAccent

  // Determine display name
  let roleName: string
  if (isUser) {
    roleName = userDisplayName || 'User'
  } else {
    const presentation = getHarnessPresentation(sessionSource)
    roleName = presentation.displayName
  }

  // Apply privacy sanitization to the message text
  const sanitized = sanitizeText(msg.text, privacy)

  // Format content: plain for user, basic formatting for assistant
  const contentHtml = isUser ? escapeHtml(sanitized).replace(/\n/g, '<br/>') : formatAssistantText(sanitized)

  // Tool call indicators (if any and not excluded)
  let toolsHtml = ''
  if (msg.toolCalls && msg.toolCalls.length > 0 && !privacy.excludeToolResults) {
    const toolNames = msg.toolCalls.map((tc) => escapeHtml(tc.name)).join(', ')
    toolsHtml = `<div style="margin-top:8px;font-size:11px;color:${theme.vars.textMuted};font-style:italic;">Tools: ${toolNames}</div>`
  }

  return `
    <div style="margin-bottom:${MESSAGE_GAP}px;">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;">
        <div style="width:24px;height:24px;border-radius:50%;background:${roleColor};display:flex;align-items:center;justify-content:center;">
          <span style="color:white;font-size:11px;font-weight:600;">${escapeHtml(roleName.charAt(0).toUpperCase())}</span>
        </div>
        <span style="font-size:13px;font-weight:600;color:${roleColor};">${escapeHtml(roleName)}</span>
      </div>
      <div style="padding-left:32px;font-size:14px;line-height:1.6;color:${theme.vars.text};word-break:break-word;">${contentHtml}${toolsHtml}</div>
    </div>
  `
}

/**
 * Build the full share card HTML.
 */
function buildCardHtml(options: ShareRenderOptions): string {
  const { messages, theme, showWatermark, privacy, sessionSource, userDisplayName } = options

  const messagesHtml = messages
    .map((msg) => buildMessageHtml(msg, theme, privacy, sessionSource, userDisplayName))
    .join('')

  const watermarkHtml = showWatermark
    ? `<div style="text-align:right;padding-top:16px;border-top:1px solid ${theme.vars.border};margin-top:8px;">
         <span style="font-size:11px;color:${theme.vars.watermark};font-style:italic;">via Swob</span>
       </div>`
    : ''

  return `
    <div xmlns="http://www.w3.org/1999/xhtml" style="
      width:${CARD_WIDTH}px;
      padding:${CARD_PADDING}px;
      background:${theme.vars.bg};
      font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
      box-sizing:border-box;
      border-radius:12px;
    ">
      ${messagesHtml}
      ${watermarkHtml}
    </div>
  `
}

/**
 * Measure the actual height of the card content by rendering it in a hidden div.
 * Returns the measured height.
 */
function measureCardHeight(html: string): number {
  const container = document.createElement('div')
  container.style.cssText = 'position:absolute;left:-9999px;top:-9999px;visibility:hidden;pointer-events:none;'
  container.innerHTML = html
  document.body.appendChild(container)
  const height = container.firstElementChild?.scrollHeight ?? 400
  document.body.removeChild(container)
  return height
}

/**
 * Split messages into pages if total height exceeds maxHeight.
 * Returns arrays of message groups, each fitting within maxHeight.
 */
function paginateMessages(
  messages: ShareMessage[],
  theme: ShareTheme,
  privacy: PrivacyOptions,
  sessionSource: string | undefined,
  userDisplayName: string | undefined,
  showWatermark: boolean,
  maxHeight: number,
): ShareMessage[][] {
  if (messages.length <= 1) return [messages]

  // Try rendering all at once
  const fullHtml = buildCardHtml({
    messages,
    theme,
    showWatermark,
    privacy,
    sessionSource,
    userDisplayName,
  })
  const fullHeight = measureCardHeight(fullHtml)

  if (fullHeight <= maxHeight) return [messages]

  // Split into pages
  const pages: ShareMessage[][] = []
  let currentPage: ShareMessage[] = []

  for (const msg of messages) {
    currentPage.push(msg)
    const testHtml = buildCardHtml({
      messages: currentPage,
      theme,
      showWatermark,
      privacy,
      sessionSource,
      userDisplayName,
    })
    const testHeight = measureCardHeight(testHtml)

    if (testHeight > maxHeight && currentPage.length > 1) {
      // Remove last message, finalize page
      currentPage.pop()
      pages.push([...currentPage])
      currentPage = [msg]
    }
  }

  if (currentPage.length > 0) {
    pages.push(currentPage)
  }

  return pages
}

/**
 * Render a single page of messages to a PNG data URL.
 */
async function renderPageToPng(options: ShareRenderOptions): Promise<string> {
  const html = buildCardHtml(options)
  const height = measureCardHeight(html) + 4 // small padding

  // Wrap in SVG foreignObject
  const svgContent = `
    <svg xmlns="http://www.w3.org/2000/svg" width="${CARD_WIDTH + CARD_PADDING * 2}" height="${height}">
      <foreignObject width="100%" height="100%">
        ${html}
      </foreignObject>
    </svg>
  `

  const totalWidth = CARD_WIDTH + CARD_PADDING * 2

  // Convert SVG to data URL
  const svgBlob = new Blob([svgContent], { type: 'image/svg+xml;charset=utf-8' })
  const svgUrl = URL.createObjectURL(svgBlob)

  return new Promise<string>((resolve, reject) => {
    const img = new Image()
    img.onload = () => {
      // Render at 2x for retina quality
      const scale = 2
      const canvas = document.createElement('canvas')
      canvas.width = totalWidth * scale
      canvas.height = height * scale
      const ctx = canvas.getContext('2d')
      if (!ctx) {
        URL.revokeObjectURL(svgUrl)
        reject(new Error('Canvas context unavailable'))
        return
      }
      ctx.scale(scale, scale)
      ctx.drawImage(img, 0, 0, totalWidth, height)
      URL.revokeObjectURL(svgUrl)
      resolve(canvas.toDataURL('image/png'))
    }
    img.onerror = () => {
      URL.revokeObjectURL(svgUrl)
      reject(new Error('Failed to load SVG for rendering'))
    }
    img.src = svgUrl
  })
}

/**
 * Main entry point: render selected messages to PNG(s).
 *
 * Returns an array of PNG data URLs (multiple pages if content is tall).
 */
export async function renderShareImage(options: ShareRenderOptions): Promise<string[]> {
  const maxHeight = options.maxHeight ?? MAX_HEIGHT_DEFAULT

  const pages = paginateMessages(
    options.messages,
    options.theme,
    options.privacy,
    options.sessionSource,
    options.userDisplayName,
    options.showWatermark,
    maxHeight,
  )

  const results: string[] = []
  for (const pageMessages of pages) {
    const png = await renderPageToPng({
      ...options,
      messages: pageMessages,
    })
    results.push(png)
  }

  return results
}

/**
 * Extract base64 data from a data URL (strips the prefix).
 */
export function dataUrlToBase64(dataUrl: string): string {
  const idx = dataUrl.indexOf(',')
  return idx >= 0 ? dataUrl.slice(idx + 1) : dataUrl
}
