import * as fs from 'node:fs'
import * as path from 'node:path'
import type { LegacySessionSource } from '../src/shared/provider-capabilities'

type Environment = Record<string, string | undefined>

/**
 * Provider-specific home overrides represented by the builtin provider
 * registry. E2E launchers must clear every override so fixtures fall back to
 * their sandboxed HOME and platform config roots.
 */
export const E2E_PROVIDER_HOME_ENVIRONMENT_VARIABLES = {
  'claude-code': ['CLAUDE_CONFIG_DIR'],
  codex: ['CODEX_HOME'],
  cursor: ['CURSOR_HOME'],
  opencode: ['OPENCODE_CONFIG_DIR'],
  zcode: ['ZCODE_HOME'],
  'cc-mirror': ['CC_MIRROR_HOME'],
  antigravity: ['ANTIGRAVITY_HOME'],
  grok: ['GROK_HOME', 'FACTORY_HOME'],
  pi: ['PI_CODING_AGENT_DIR', 'PI_CODING_AGENT_SESSION_DIR', 'PI_PACKAGE_DIR'],
  kimi: ['KIMI_HOME'],
  hermes: ['HERMES_HOME'],
  qoder: ['QODER_HOME'],
  trae: ['TRAE_HOME'],
  gemini: ['GEMINI_CLI_HOME']
} as const satisfies Record<LegacySessionSource, readonly string[]>

export const E2E_PLATFORM_HOME_ENVIRONMENT_VARIABLES = [
  'XDG_CACHE_HOME',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_STATE_HOME',
  'XDG_RUNTIME_DIR',
  'APPDATA',
  'LOCALAPPDATA'
] as const

export const E2E_ALL_PROVIDER_HOME_ENVIRONMENT_VARIABLES = [
  ...new Set(Object.values(E2E_PROVIDER_HOME_ENVIRONMENT_VARIABLES).flat())
] as const

export const E2E_CLEARED_PROVIDER_HOME_OVERRIDES = 'SWOB_E2E_CLEARED_PROVIDER_HOME_OVERRIDES'

function isContained(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate))
  return relative === '' || (
    !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)
  )
}

/** Clear external provider roots before Playwright creates worker processes. */
export function clearE2EProviderHomeOverrides(environment: Environment): string[] {
  const cleared: string[] = []
  for (const name of E2E_ALL_PROVIDER_HOME_ENVIRONMENT_VARIABLES) {
    if (environment[name] !== undefined) cleared.push(name)
    delete environment[name]
  }
  return cleared
}

/** Apply the full provider-home contract to one Electron launch environment. */
export function isolateE2EProviderHomeEnvironment(
  environment: Environment,
  sandboxRoot: string
): void {
  clearE2EProviderHomeOverrides(environment)
  for (const name of E2E_PLATFORM_HOME_ENVIRONMENT_VARIABLES) {
    const directory = path.join(sandboxRoot, 'provider-homes', name.toLowerCase())
    fs.mkdirSync(directory, { recursive: true })
    environment[name] = directory
  }
}

export function assertE2EProviderHomeEnvironmentIsolated(
  environment: Environment,
  sandboxRoot: string
): void {
  for (const name of E2E_ALL_PROVIDER_HOME_ENVIRONMENT_VARIABLES) {
    if (environment[name] !== undefined) {
      throw new Error(`E2E provider-home isolation failed: inherited-${name}`)
    }
  }
  for (const name of E2E_PLATFORM_HOME_ENVIRONMENT_VARIABLES) {
    const value = environment[name]
    if (!value) throw new Error(`E2E provider-home isolation failed: missing-${name}`)
    if (!isContained(sandboxRoot, value)) {
      throw new Error(`E2E provider-home isolation failed: ${name}-outside-sandbox`)
    }
  }
}
