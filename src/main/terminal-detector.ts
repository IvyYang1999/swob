import * as fs from 'node:fs'
import { execFile, spawnSync } from 'node:child_process'
import { promisify } from 'node:util'

export interface TerminalDefinition {
  id: string
  name: string
  platforms: NodeJS.Platform[]
  paths: string[]
  bins: string[]
  bundleId?: string
  commandSupport: 'stable' | 'conditional' | 'none'
  limitation?: string
}

export interface DetectedTerminal {
  id: string
  name: string
  path: string
  executable?: string
  commandSupport: TerminalDefinition['commandSupport']
  canRunCommand: boolean
  limitation?: string
  evidence: 'system-path' | 'app-path' | 'bundle-id' | 'executable'
}

export const TERMINAL_DEFINITIONS: TerminalDefinition[] = [
  { id: 'apple-terminal', name: 'Terminal', platforms: ['darwin'], bundleId: 'com.apple.Terminal', paths: ['/System/Applications/Utilities/Terminal.app', '/Applications/Utilities/Terminal.app'], bins: [], commandSupport: 'stable' },
  { id: 'iterm2', name: 'iTerm2', platforms: ['darwin'], bundleId: 'com.googlecode.iterm2', paths: ['/Applications/iTerm.app'], bins: [], commandSupport: 'stable' },
  { id: 'ghostty', name: 'Ghostty', platforms: ['darwin', 'linux'], bundleId: 'com.mitchellh.ghostty', paths: ['/Applications/Ghostty.app'], bins: ['ghostty'], commandSupport: 'stable' },
  { id: 'wezterm', name: 'WezTerm', platforms: ['darwin', 'linux', 'win32'], bundleId: 'com.github.wez.wezterm', paths: ['/Applications/WezTerm.app'], bins: ['wezterm', 'wezterm.exe'], commandSupport: 'stable' },
  { id: 'kitty', name: 'kitty', platforms: ['darwin', 'linux'], bundleId: 'net.kovidgoyal.kitty', paths: ['/Applications/kitty.app'], bins: ['kitty'], commandSupport: 'stable' },
  { id: 'alacritty', name: 'Alacritty', platforms: ['darwin', 'linux', 'win32'], bundleId: 'org.alacritty', paths: ['/Applications/Alacritty.app'], bins: ['alacritty', 'alacritty.exe'], commandSupport: 'stable' },
  { id: 'windows-terminal', name: 'Windows Terminal', platforms: ['win32'], paths: [], bins: ['wt.exe'], commandSupport: 'stable' },
  { id: 'gnome-terminal', name: 'GNOME Terminal', platforms: ['linux'], paths: [], bins: ['gnome-terminal'], commandSupport: 'stable' },
  { id: 'konsole', name: 'Konsole', platforms: ['linux'], paths: [], bins: ['konsole'], commandSupport: 'stable' },
  { id: 'foot', name: 'foot', platforms: ['linux'], paths: [], bins: ['foot'], commandSupport: 'stable' },
  { id: 'xfce4-terminal', name: 'XFCE Terminal', platforms: ['linux'], paths: [], bins: ['xfce4-terminal'], commandSupport: 'stable' },
  { id: 'warp', name: 'Warp', platforms: ['darwin', 'linux', 'win32'], bundleId: 'dev.warp.Warp-Stable', paths: ['/Applications/Warp.app'], bins: ['warp', 'warp.exe'], commandSupport: 'conditional', limitation: '任意命令需要预先配置 Launch Configuration' },
  { id: 'hyper', name: 'Hyper', platforms: ['darwin', 'linux', 'win32'], bundleId: 'co.zeit.hyper', paths: ['/Applications/Hyper.app'], bins: ['hyper', 'hyper.exe'], commandSupport: 'none', limitation: '公开 CLI 只能打开路径，不能执行 Resume 命令' },
  { id: 'tabby', name: 'Tabby', platforms: ['darwin', 'linux', 'win32'], bundleId: 'org.tabby', paths: ['/Applications/Tabby.app'], bins: ['tabby', 'Tabby.exe'], commandSupport: 'none', limitation: '没有稳定公开的外部命令入口' }
]

export interface TerminalDetectorDeps {
  platform: NodeJS.Platform
  exists: (filePath: string) => boolean
  findExecutable: (name: string) => string | null
  findBundle: (bundleId: string) => string | null
}

function commandPath(name: string, platform = process.platform): string | null {
  const finder = platform === 'win32' ? 'where.exe' : '/usr/bin/which'
  const result = spawnSync(finder, [name], { encoding: 'utf8', timeout: 1500, windowsHide: true })
  if (result.status !== 0) return null
  return result.stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean) || null
}

function bundlePath(bundleId: string): string | null {
  if (process.platform !== 'darwin') return null
  const result = spawnSync('/usr/bin/mdfind', [`kMDItemCFBundleIdentifier == '${bundleId}'`], {
    encoding: 'utf8', timeout: 2000, windowsHide: true
  })
  if (result.status !== 0) return null
  return result.stdout.split(/\r?\n/).map((line) => line.trim()).find((line) => line.endsWith('.app')) || null
}

const defaultDeps: TerminalDetectorDeps = {
  platform: process.platform,
  exists: fs.existsSync,
  findExecutable: (name) => commandPath(name),
  findBundle: bundlePath
}

const execFileAsync = promisify(execFile)

async function commandPathAsync(name: string, platform = process.platform): Promise<string | null> {
  const finder = platform === 'win32' ? 'where.exe' : '/usr/bin/which'
  try {
    const { stdout } = await execFileAsync(finder, [name], {
      encoding: 'utf8', timeout: 1500, windowsHide: true
    })
    return stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean) || null
  } catch {
    return null
  }
}

async function bundlePathAsync(bundleId: string): Promise<string | null> {
  if (process.platform !== 'darwin') return null
  try {
    const { stdout } = await execFileAsync('/usr/bin/mdfind', [`kMDItemCFBundleIdentifier == '${bundleId}'`], {
      encoding: 'utf8', timeout: 2000, windowsHide: true
    })
    return stdout.split(/\r?\n/).map((line) => line.trim()).find((line) => line.endsWith('.app')) || null
  } catch {
    return null
  }
}

async function detectInstalledTerminalsWithoutBlockingMain(): Promise<DetectedTerminal[]> {
  const definitions = TERMINAL_DEFINITIONS.filter((definition) => definition.platforms.includes(process.platform))
  const binNames = [...new Set(definitions.flatMap((definition) => definition.bins))]
  const bundleIds = [...new Set(definitions.map((definition) => definition.bundleId).filter(Boolean) as string[])]
  const [binEntries, bundleEntries] = await Promise.all([
    Promise.all(binNames.map(async (name) => [name, await commandPathAsync(name)] as const)),
    Promise.all(bundleIds.map(async (bundleId) => [bundleId, await bundlePathAsync(bundleId)] as const))
  ])
  const bins = new Map(binEntries)
  const bundles = new Map(bundleEntries)
  return detectInstalledTerminals({
    platform: process.platform,
    exists: fs.existsSync,
    findExecutable: (name) => bins.get(name) || null,
    findBundle: (bundleId) => bundles.get(bundleId) || null
  })
}

export function detectInstalledTerminals(deps: TerminalDetectorDeps = defaultDeps): DetectedTerminal[] {
  const detected: DetectedTerminal[] = []
  for (const definition of TERMINAL_DEFINITIONS) {
    if (!definition.platforms.includes(deps.platform)) continue

    const executable = definition.bins.map(deps.findExecutable).find(Boolean) || undefined
    const systemPath = definition.paths.find((candidate) => deps.exists(candidate))
    const bundle = !systemPath && definition.bundleId ? deps.findBundle(definition.bundleId) : null
    const appPath = systemPath || bundle || undefined
    if (!executable && !appPath) continue

    const builtInAdapter = definition.id === 'apple-terminal' || definition.id === 'iterm2'
    const canRunCommand = definition.commandSupport === 'stable' && (builtInAdapter || !!executable)
    detected.push({
      id: definition.id,
      name: definition.name,
      path: executable || appPath!,
      executable,
      commandSupport: definition.commandSupport,
      canRunCommand,
      limitation: canRunCommand
        ? definition.limitation
        : definition.limitation || (definition.commandSupport === 'stable' ? '检测到 App，但没有可执行命令入口' : undefined),
      evidence: executable
        ? 'executable'
        : systemPath?.startsWith('/System/') ? 'system-path'
          : systemPath ? 'app-path' : 'bundle-id'
    })
  }
  return detected.sort((a, b) => {
    if (a.id === 'apple-terminal') return -1
    if (b.id === 'apple-terminal') return 1
    if (a.canRunCommand !== b.canRunCommand) return a.canRunCommand ? -1 : 1
    return a.name.localeCompare(b.name)
  })
}

let terminalCache: Promise<DetectedTerminal[]> | null = null
let resolvedTerminals: DetectedTerminal[] = []

export function getDetectedTerminals(force = false): Promise<DetectedTerminal[]> {
  if (force || !terminalCache) {
    terminalCache = detectInstalledTerminalsWithoutBlockingMain().then((terminals) => {
      resolvedTerminals = terminals
      return resolvedTerminals
    })
  }
  return terminalCache
}

export function peekDetectedTerminals(): DetectedTerminal[] {
  return resolvedTerminals
}

export function primeTerminalDetection(): void {
  void getDetectedTerminals()
}
