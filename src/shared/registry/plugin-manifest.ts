export const SWOB_PLUGIN_EXECUTION_ENABLED = false as const

export interface SwobPluginManifest {
  id: string
  name: string
  version: string
  apiVersion: number
  minAppVersion: string
  entry: string
  description?: string
  permissions?: string[]
  contributes?: {
    commands?: string[]
    views?: string[]
    widgets?: string[]
  }
}

export interface SwobPluginLoader {
  discover(): Promise<SwobPluginManifest[]>
  load(manifest: SwobPluginManifest): Promise<never>
}

export class DisabledSwobPluginLoader implements SwobPluginLoader {
  async discover(): Promise<SwobPluginManifest[]> {
    return []
  }

  async load(_manifest: SwobPluginManifest): Promise<never> {
    throw new Error('Plugin execution is disabled')
  }
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

export function isSwobPluginManifest(value: unknown): value is SwobPluginManifest {
  if (!value || typeof value !== 'object') return false
  const manifest = value as Record<string, unknown>
  const entry = manifest.entry
  if (
    typeof manifest.id !== 'string' ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(manifest.id) ||
    typeof manifest.name !== 'string' ||
    manifest.name.trim().length === 0 ||
    typeof manifest.version !== 'string' ||
    !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(manifest.version) ||
    !Number.isInteger(manifest.apiVersion) ||
    (manifest.apiVersion as number) < 1 ||
    typeof manifest.minAppVersion !== 'string' ||
    !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(manifest.minAppVersion) ||
    typeof entry !== 'string' ||
    entry.length === 0 ||
    entry.startsWith('/') ||
    entry.startsWith('\\') ||
    /^[A-Za-z]:[\\/]/.test(entry) ||
    /^[a-z][a-z0-9+.-]*:/i.test(entry) ||
    entry.split(/[\\/]/).includes('..')
  ) return false

  if (manifest.description !== undefined && typeof manifest.description !== 'string') return false
  if (manifest.permissions !== undefined && !isStringArray(manifest.permissions)) return false
  if (manifest.contributes !== undefined) {
    if (!manifest.contributes || typeof manifest.contributes !== 'object') return false
    const contributes = manifest.contributes as Record<string, unknown>
    for (const key of ['commands', 'views', 'widgets']) {
      if (contributes[key] !== undefined && !isStringArray(contributes[key])) return false
    }
  }
  return true
}
