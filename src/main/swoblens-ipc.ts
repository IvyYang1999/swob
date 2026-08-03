import type {
  InstalledSwobLensPackage,
  SwobLensIpcResult,
  SwobLensPackageList,
  SwobLensPackagePreview
} from '../shared/swoblens-manifest'
import {
  SwobLensPackageError,
  installSwobLensPackage,
  listInstalledSwobLensPackages,
  previewSwobLensPackage,
  setSwobLensPackageEnabled,
  uninstallSwobLensPackage
} from './swoblens-installer'
import { SwobLensValidationError } from '../shared/swoblens-validator'

export interface SwobLensIpcRegistrar {
  handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void
}

export interface SwobLensIpcDependencies {
  readonly ipcMain: SwobLensIpcRegistrar
  readonly getLibraryRoot: () => string
  readonly getAppVersion: () => string
  readonly withLibraryWriter: <T>(operation: () => Promise<T> | T) => Promise<T>
  readonly showOpenDialog: (options: {
    properties: Array<'openFile'>
    filters: Array<{ name: string; extensions: string[] }>
  }) => Promise<{ canceled: boolean; filePaths: string[] }>
}

function failure(error: unknown): SwobLensIpcResult<never> {
  if (error instanceof SwobLensPackageError || error instanceof SwobLensValidationError) {
    return { ok: false, error: { code: error.code, message: error.message } }
  }
  if (error && typeof error === 'object' && (error as { code?: unknown }).code === 'LIBRARY_WRITER_BUSY') {
    return {
      ok: false,
      error: {
        code: 'LIBRARY_WRITER_BUSY',
        message: error instanceof Error ? error.message : 'Library writer is busy; try again later'
      }
    }
  }
  return { ok: false, error: { code: 'SWOBLENS_OPERATION_FAILED', message: 'The declarative package operation failed' } }
}

function validMutation(value: unknown): value is { id: string; enabled: boolean } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const input = value as Record<string, unknown>
  return Object.keys(input).length === 2 && typeof input.id === 'string' && typeof input.enabled === 'boolean'
}

function validInstall(value: unknown): value is { sourcePath: string; digest: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const input = value as Record<string, unknown>
  return Object.keys(input).length === 2 && typeof input.sourcePath === 'string' &&
    typeof input.digest === 'string' && /^[a-f0-9]{64}$/.test(input.digest)
}

export function registerSwobLensIpc(dependencies: SwobLensIpcDependencies): void {
  const { ipcMain } = dependencies

  ipcMain.handle('swoblens:selectAndPreview', async (): Promise<SwobLensIpcResult<SwobLensPackagePreview | null>> => {
    try {
      const selection = await dependencies.showOpenDialog({
        properties: ['openFile'],
        filters: [{ name: 'Swob declarative packages', extensions: ['swoblens'] }]
      })
      if (selection.canceled || selection.filePaths.length === 0) return { ok: true, value: null }
      const preview = await previewSwobLensPackage(selection.filePaths[0], dependencies.getAppVersion())
      return { ok: true, value: preview }
    } catch (error) {
      return failure(error)
    }
  })

  ipcMain.handle('swoblens:list', async (): Promise<SwobLensIpcResult<SwobLensPackageList>> => {
    try {
      return { ok: true, value: await listInstalledSwobLensPackages(dependencies.getLibraryRoot()) }
    } catch (error) {
      return failure(error)
    }
  })

  ipcMain.handle('swoblens:install', async (_event, input): Promise<SwobLensIpcResult<InstalledSwobLensPackage>> => {
    if (!validInstall(input)) return { ok: false, error: { code: 'INVALID_REQUEST', message: 'Invalid install request' } }
    try {
      const installed = await dependencies.withLibraryWriter(async () => {
        const value = await installSwobLensPackage(
          input.sourcePath,
          input.digest,
          dependencies.getLibraryRoot(),
          dependencies.getAppVersion()
        )
        if (value.manifest.type === 'theme' || value.manifest.type === 'lens-preset') {
          return setSwobLensPackageEnabled(dependencies.getLibraryRoot(), value.manifest.id, true)
        }
        return value
      })
      return { ok: true, value: installed }
    } catch (error) {
      return failure(error)
    }
  })

  ipcMain.handle('swoblens:setEnabled', async (_event, input): Promise<SwobLensIpcResult<InstalledSwobLensPackage>> => {
    if (!validMutation(input)) return { ok: false, error: { code: 'INVALID_REQUEST', message: 'Invalid package state request' } }
    try {
      const installed = await dependencies.withLibraryWriter(() => setSwobLensPackageEnabled(
        dependencies.getLibraryRoot(),
        input.id,
        input.enabled
      ))
      return { ok: true, value: installed }
    } catch (error) {
      return failure(error)
    }
  })

  ipcMain.handle('swoblens:uninstall', async (_event, id): Promise<SwobLensIpcResult<null>> => {
    if (typeof id !== 'string') return { ok: false, error: { code: 'INVALID_REQUEST', message: 'Invalid uninstall request' } }
    try {
      await dependencies.withLibraryWriter(() => uninstallSwobLensPackage(dependencies.getLibraryRoot(), id))
      return { ok: true, value: null }
    } catch (error) {
      return failure(error)
    }
  })
}
