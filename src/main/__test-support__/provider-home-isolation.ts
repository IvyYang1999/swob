import * as fs from 'node:fs'
import * as path from 'node:path'
import type { LegacySessionSource } from '../../shared/provider-capabilities'

/**
 * Home/config overrides associated with the CLIs represented in the builtin
 * provider registry. This includes upstream overrides and harness-level aliases
 * named after providers. Providers without an upstream-specific override still
 * inherit the isolated HOME and XDG roots installed by the Vitest bootstrap.
 *
 * Keep this exhaustive so a newly registered provider cannot silently inherit
 * a machine-level home override in tests.
 */
export const PROVIDER_HOME_ENVIRONMENT_VARIABLES = {
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

export const PLATFORM_HOME_ENVIRONMENT_VARIABLES = [
  'XDG_CACHE_HOME',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_STATE_HOME',
  'XDG_RUNTIME_DIR',
  'APPDATA',
  'LOCALAPPDATA'
] as const

export const ALL_PROVIDER_HOME_ENVIRONMENT_VARIABLES = [
  ...new Set(Object.values(PROVIDER_HOME_ENVIRONMENT_VARIABLES).flat())
] as const

function isContained(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate))
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

export function isolateProviderHomeEnvironment(
  environment: NodeJS.ProcessEnv,
  sandboxRoot: string
): string[] {
  const directories = new Set<string>()
  // A provider-specific override would add another discovery/config root and
  // change tests that deliberately pass their own `home`. Clearing overrides
  // preserves those semantics while every provider falls back to the isolated
  // HOME/XDG roots below. Deletion also propagates to child-process env copies.
  for (const name of ALL_PROVIDER_HOME_ENVIRONMENT_VARIABLES) {
    delete environment[name]
  }
  for (const name of PLATFORM_HOME_ENVIRONMENT_VARIABLES) {
    const directory = path.join(sandboxRoot, 'platform-homes', name.toLowerCase())
    environment[name] = directory
    directories.add(directory)
  }
  for (const directory of directories) fs.mkdirSync(directory, { recursive: true })
  return [...directories]
}

export function assertProviderHomeEnvironmentIsolated(
  environment: NodeJS.ProcessEnv,
  sandboxRoot: string
): void {
  for (const name of [
    ...ALL_PROVIDER_HOME_ENVIRONMENT_VARIABLES,
    ...PLATFORM_HOME_ENVIRONMENT_VARIABLES
  ]) {
    const value = environment[name]
    if (!value && (ALL_PROVIDER_HOME_ENVIRONMENT_VARIABLES as readonly string[]).includes(name)) continue
    if (!value) throw new Error(`Test isolation violation: missing-${name}`)
    if (!isContained(sandboxRoot, value)) {
      throw new Error(`Test isolation violation: ${name}-outside-sandbox`)
    }
  }
}
