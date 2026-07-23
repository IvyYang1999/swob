import { useEffect, useMemo, useState } from 'react'

export type MacArchitecture = 'arm64' | 'x64'

export const RELEASE_VERSION = '1.3.1'
export const RELEASE_PAGE_URL = `https://github.com/IvyYang1999/swob/releases/tag/v${RELEASE_VERSION}`

export function macDownloadUrl(architecture: MacArchitecture): string {
  return `https://github.com/IvyYang1999/swob/releases/download/v${RELEASE_VERSION}/swob-${RELEASE_VERSION}-${architecture}.dmg`
}

function architectureFromRenderer(): MacArchitecture | null {
  try {
    const canvas = document.createElement('canvas')
    const gl = canvas.getContext('webgl')
    if (!gl) return null
    const extension = gl.getExtension('WEBGL_debug_renderer_info')
    if (!extension) return null
    const renderer = String(gl.getParameter(extension.UNMASKED_RENDERER_WEBGL)).toLowerCase()
    if (/\bintel\b|\bamd\b/.test(renderer)) return 'x64'
    if (/\bapple\b|\bm[1-9]\b/.test(renderer)) return 'arm64'
  } catch {
    // Architecture detection is only a convenience. The explicit alternate
    // download remains available when browser privacy controls hide it.
  }
  return null
}

async function architectureFromClientHints(): Promise<MacArchitecture | null> {
  type UserAgentData = {
    getHighEntropyValues?: (hints: string[]) => Promise<{ architecture?: string; bitness?: string }>
  }
  const userAgentData = (navigator as Navigator & { userAgentData?: UserAgentData }).userAgentData
  if (!userAgentData?.getHighEntropyValues) return null
  try {
    const hints = await userAgentData.getHighEntropyValues(['architecture', 'bitness'])
    const architecture = hints.architecture?.toLowerCase()
    if (architecture === 'arm' || architecture === 'arm64') return 'arm64'
    if (architecture === 'x86' || architecture === 'x86_64') return 'x64'
  } catch {
    // Fall back to the renderer signal or the explicit architecture links.
  }
  return null
}

export function useMacDownload(): {
  architecture: MacArchitecture
  url: string
  alternateArchitecture: MacArchitecture
  alternateUrl: string
} {
  const [architecture, setArchitecture] = useState<MacArchitecture>(() => architectureFromRenderer() ?? 'arm64')

  useEffect(() => {
    let active = true
    void architectureFromClientHints().then((detected) => {
      if (active && detected) setArchitecture(detected)
    })
    return () => { active = false }
  }, [])

  return useMemo(() => {
    const alternateArchitecture = architecture === 'arm64' ? 'x64' : 'arm64'
    return {
      architecture,
      url: macDownloadUrl(architecture),
      alternateArchitecture,
      alternateUrl: macDownloadUrl(alternateArchitecture),
    }
  }, [architecture])
}
