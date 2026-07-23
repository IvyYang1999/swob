import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { SessionSummary } from './types'
import { PathContainmentError, resolvePathWithinRoot } from './path-containment'
import { HARNESS_CAPABILITIES } from '../shared/settings-capabilities'
import type {
  AgentAlwaysOnTopState,
  AgentHistoryItem,
  FrontendIpcErrorCode,
  FrontendIpcResult,
  HarnessIconOverride,
  HarnessIconOverrideInput,
  ImageSelectionResult,
  ShareCopyPngResult,
  ShareSavePngResult,
  SpotlightNativeShadowState,
  UserIdentity,
  UserIdentityInput
} from '../shared/frontend-ipc-contract'

const MAX_AVATAR_BYTES = 2 * 1024 * 1024
const MAX_SHARE_PNG_BYTES = 32 * 1024 * 1024
const DEFAULT_DISPLAY_NAME = 'User'
const MANAGED_ASSET_DIR = path.join('.swob', 'assets')
const REGISTERED_HARNESS_SOURCES = new Set(
  HARNESS_CAPABILITIES.flatMap((harness) => [harness.id, ...harness.sourceIds])
)

class FrontendIpcException extends Error {
  constructor(readonly code: FrontendIpcErrorCode, message: string) {
    super(message)
    this.name = 'FrontendIpcException'
  }
}

function fail<T>(error: unknown, fallbackCode: FrontendIpcErrorCode = 'INTERNAL_ERROR'): FrontendIpcResult<T> {
  if (error instanceof FrontendIpcException) {
    return { ok: false, error: { code: error.code, message: error.message } }
  }
  return {
    ok: false,
    error: {
      code: fallbackCode,
      message: error instanceof Error ? error.message : 'Operation failed'
    }
  }
}

function normalizedPath(input: string): string {
  try {
    return fs.realpathSync.native(input)
  } catch {
    return path.resolve(input)
  }
}

export function buildAgentHistory(
  sessions: SessionSummary[],
  agentWorkspaceDir: string,
  titleForSession: (session: SessionSummary) => string | undefined = () => undefined
): AgentHistoryItem[] {
  const workspace = normalizedPath(agentWorkspaceDir)
  const byId = new Map<string, AgentHistoryItem>()
  for (const session of sessions) {
    const sessionCwds = [...session.cwds, ...(session.resumeCwd ? [session.resumeCwd] : [])]
    if (!sessionCwds.some((cwd) => normalizedPath(cwd) === workspace)) continue
    const id = session.sessionId
    const item = {
      id,
      title: (titleForSession(session) || session.firstUserMessage || id).trim().slice(0, 200),
      updatedAt: session.updatedAt,
      turnCount: session.turnCount
    }
    const current = byId.get(id)
    if (!current || item.updatedAt > current.updatedAt) byId.set(id, item)
  }
  return [...byId.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

interface AlwaysOnTopWindow {
  isDestroyed(): boolean
  setAlwaysOnTop(flag: boolean): void
}

export async function setAlwaysOnTopPreference(flag: unknown, options: {
  previousValue: boolean
  getWindow: () => AlwaysOnTopWindow | null
  persist: (flag: boolean) => void | Promise<void>
}): Promise<FrontendIpcResult<AgentAlwaysOnTopState>> {
  if (typeof flag !== 'boolean') return fail(new FrontendIpcException('INVALID_INPUT', 'flag must be a boolean'))
  const win = options.getWindow()
  const usableWindow = win && !win.isDestroyed() ? win : null
  try {
    usableWindow?.setAlwaysOnTop(flag)
    await options.persist(flag)
    return { ok: true, value: { alwaysOnTop: flag, windowOpen: usableWindow !== null } }
  } catch (error) {
    try { usableWindow?.setAlwaysOnTop(options.previousValue) } catch { /* best-effort rollback */ }
    return fail(error, 'OPERATION_FAILED')
  }
}

interface ShadowWindow {
  isDestroyed(): boolean
  setHasShadow(flag: boolean): void
}

export function setNativeShadowPreference(flag: unknown, options: {
  platform: NodeJS.Platform
  getWindow: () => ShadowWindow | null
}): FrontendIpcResult<SpotlightNativeShadowState> {
  if (typeof flag !== 'boolean') return fail(new FrontendIpcException('INVALID_INPUT', 'flag must be a boolean'))
  if (options.platform !== 'darwin') {
    return { ok: true, value: { nativeShadow: flag, supported: false, applied: false } }
  }
  const win = options.getWindow()
  if (!win || win.isDestroyed()) {
    return { ok: true, value: { nativeShadow: flag, supported: true, applied: false } }
  }
  try {
    win.setHasShadow(flag)
    return { ok: true, value: { nativeShadow: flag, supported: true, applied: true } }
  } catch (error) {
    return fail(error, 'OPERATION_FAILED')
  }
}

export interface ProfileDependencies {
  getLibraryRoot: () => string
  getPreferences: () => Record<string, unknown>
  updatePreferences: (patch: Record<string, unknown>) => void | Promise<void>
  withLibraryWriter: <T>(operation: () => Promise<T> | T) => Promise<T>
  showOpenDialog?: (options: {
    properties: Array<'openFile'>
    filters: Array<{ name: string; extensions: string[] }>
  }) => Promise<{ canceled: boolean; filePaths: string[] }>
  convertSvgToPng?: (buffer: Buffer) => Buffer
}

interface PersistedIdentity {
  displayName: string
  avatarRelPath?: string
}

function readPersistedIdentity(preferences: Record<string, unknown>): PersistedIdentity {
  const candidate = preferences.userIdentity
  if (!candidate || typeof candidate !== 'object') return { displayName: DEFAULT_DISPLAY_NAME }
  const record = candidate as Record<string, unknown>
  const displayName = typeof record.displayName === 'string' && record.displayName.trim()
    ? record.displayName.trim().slice(0, 80)
    : DEFAULT_DISPLAY_NAME
  return {
    displayName,
    avatarRelPath: typeof record.avatarRelPath === 'string' && record.avatarRelPath
      ? record.avatarRelPath
      : undefined
  }
}

function validateDisplayName(input: unknown): string {
  if (typeof input !== 'string') throw new FrontendIpcException('INVALID_INPUT', 'displayName must be a string')
  const value = input.trim()
  if (!value || Array.from(value).length > 80 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new FrontendIpcException('INVALID_INPUT', 'displayName must contain 1 to 80 printable characters')
  }
  return value
}

type SupportedImage = 'png' | 'jpg' | 'webp' | 'svg'

function canonicalImageExtension(filePath: string): SupportedImage {
  const extension = path.extname(filePath).toLowerCase().slice(1)
  if (extension === 'png') return 'png'
  if (extension === 'jpg' || extension === 'jpeg') return 'jpg'
  if (extension === 'webp') return 'webp'
  if (extension === 'svg') return 'svg'
  throw new FrontendIpcException('INVALID_IMAGE_FORMAT', 'Image must be a PNG, JPG, WebP, or SVG file')
}

function hasImageSignature(buffer: Buffer, extension: SupportedImage): boolean {
  if (extension === 'png') return buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
  if (extension === 'jpg') return buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff
  if (extension === 'webp') {
    return buffer.length >= 12 && buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
      buffer.subarray(8, 12).toString('ascii') === 'WEBP'
  }
  const source = buffer.toString('utf8').trim()
  return /^(?:<\?xml[\s\S]*?\?>\s*)?<svg[\s>]/i.test(source) &&
    !/<(?:script|style|foreignObject|iframe|object|embed)\b/i.test(source) &&
    !/\bon[a-z]+\s*=/i.test(source) &&
    !/\b(?:href|xlink:href)\s*=/i.test(source) &&
    !/(?:javascript:|data:text\/html|url\s*\(|<!DOCTYPE|<!ENTITY)/i.test(source)
}

function readValidatedAvatar(filePath: string): { buffer: Buffer; extension: SupportedImage } {
  const extension = canonicalImageExtension(filePath)
  let descriptor: number
  try {
    descriptor = fs.openSync(filePath, 'r')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new FrontendIpcException('FILE_NOT_FOUND', 'Avatar file does not exist')
    }
    throw error
  }
  try {
    const stat = fs.fstatSync(descriptor)
    if (!stat.isFile()) throw new FrontendIpcException('INVALID_AVATAR_PATH', 'Avatar path must identify a regular file')
    if (stat.size > MAX_AVATAR_BYTES) throw new FrontendIpcException('FILE_TOO_LARGE', 'Avatar must be 2 MiB or smaller')
    // Read at most limit + 1 from the already-open descriptor. This closes the
    // stat/read race without ever allocating based on a changing file size.
    const bounded = Buffer.allocUnsafe(MAX_AVATAR_BYTES + 1)
    let bytesRead = 0
    while (bytesRead < bounded.length) {
      const count = fs.readSync(descriptor, bounded, bytesRead, bounded.length - bytesRead, bytesRead)
      if (count === 0) break
      bytesRead += count
    }
    if (bytesRead > MAX_AVATAR_BYTES) throw new FrontendIpcException('FILE_TOO_LARGE', 'Avatar must be 2 MiB or smaller')
    const buffer = Buffer.from(bounded.subarray(0, bytesRead))
    if (!hasImageSignature(buffer, extension)) {
      throw new FrontendIpcException('INVALID_IMAGE_FORMAT', 'Avatar contents do not match its image extension')
    }
    return { buffer, extension }
  } finally {
    fs.closeSync(descriptor)
  }
}

function resolveManagedAvatar(libraryRoot: string, avatarRelPath: string, mustExist: boolean): string {
  if (path.isAbsolute(avatarRelPath)) throw new FrontendIpcException('INVALID_AVATAR_PATH', 'Persisted avatar paths must be relative')
  try {
    const assetsRoot = resolvePathWithinRoot(libraryRoot, MANAGED_ASSET_DIR, {
      allowRoot: false,
      allowAbsolute: false
    })
    const candidate = resolvePathWithinRoot(libraryRoot, avatarRelPath, {
      allowRoot: false,
      allowAbsolute: false,
      mustExist
    })
    return resolvePathWithinRoot(assetsRoot, candidate, { allowRoot: false, mustExist })
  } catch (error) {
    if (error instanceof PathContainmentError) {
      throw new FrontendIpcException('INVALID_AVATAR_PATH', 'Avatar path must stay inside Library/.swob/assets')
    }
    throw error
  }
}

function ensureManagedAssetDirectory(libraryRoot: string): string {
  try {
    const swobDir = resolvePathWithinRoot(libraryRoot, '.swob', { allowRoot: false, allowAbsolute: false })
    fs.mkdirSync(swobDir, { recursive: true })
    const assetsDir = resolvePathWithinRoot(libraryRoot, MANAGED_ASSET_DIR, { allowRoot: false, allowAbsolute: false })
    fs.mkdirSync(assetsDir, { recursive: true })
    return resolvePathWithinRoot(libraryRoot, MANAGED_ASSET_DIR, { allowRoot: false, allowAbsolute: false })
  } catch (error) {
    if (error instanceof PathContainmentError) {
      throw new FrontendIpcException('INVALID_AVATAR_PATH', 'Library asset directory escapes through a symlink')
    }
    throw error
  }
}

function importManagedImage(
  libraryRoot: string,
  sourcePath: string,
  prefix: string,
  convertSvgToPng?: (buffer: Buffer) => Buffer
): string {
  const validated = readValidatedAvatar(sourcePath)
  let buffer = validated.buffer
  let extension: SupportedImage = validated.extension
  if (extension === 'svg') {
    if (!convertSvgToPng) {
      throw new FrontendIpcException('INVALID_IMAGE_FORMAT', 'SVG conversion is unavailable')
    }
    buffer = convertSvgToPng(buffer)
    extension = 'png'
    if (!hasImageSignature(buffer, 'png')) {
      throw new FrontendIpcException('INVALID_IMAGE_FORMAT', 'SVG could not be converted to a PNG')
    }
  }
  const assetsDir = ensureManagedAssetDirectory(libraryRoot)
  const digest = crypto.createHash('sha256').update(buffer).digest('hex').slice(0, 16)
  const safePrefix = prefix.replace(/[^a-z0-9-]/gi, '-').slice(0, 80)
  const filename = `${safePrefix}-${digest}.${extension}`
  const destination = resolvePathWithinRoot(assetsDir, filename, { allowRoot: false, allowAbsolute: false })
  if (!fs.existsSync(destination)) {
    const temporary = resolvePathWithinRoot(assetsDir, `.${filename}.${process.pid}.${crypto.randomUUID()}.tmp`, {
      allowRoot: false,
      allowAbsolute: false
    })
    try {
      fs.writeFileSync(temporary, buffer, { mode: 0o600, flag: 'wx' })
      fs.renameSync(temporary, destination)
    } finally {
      try { fs.unlinkSync(temporary) } catch { /* renamed or never written */ }
    }
  }
  return path.relative(libraryRoot, destination).split(path.sep).join('/')
}

function importAvatar(libraryRoot: string, sourcePath: string, convertSvgToPng?: (buffer: Buffer) => Buffer): string {
  return importManagedImage(libraryRoot, sourcePath, 'avatar', convertSvgToPng)
}

function validateHarnessSource(input: unknown): string {
  if (typeof input !== 'string' || !REGISTERED_HARNESS_SOURCES.has(input)) {
    throw new FrontendIpcException('INVALID_INPUT', 'source must be a registered harness identifier')
  }
  return input
}

function readPersistedHarnessIconOverrides(preferences: Record<string, unknown>): Record<string, string> {
  const candidate = preferences.harnessIconOverrides
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return {}
  const result: Record<string, string> = {}
  for (const [source, value] of Object.entries(candidate as Record<string, unknown>)) {
    if (REGISTERED_HARNESS_SOURCES.has(source) && typeof value === 'string' && value) {
      result[source] = value
    }
  }
  return result
}

export async function getUserIdentity(dependencies: ProfileDependencies): Promise<FrontendIpcResult<UserIdentity>> {
  try {
    const identity = readPersistedIdentity(dependencies.getPreferences())
    if (!identity.avatarRelPath) {
      return { ok: true, value: { displayName: identity.displayName, avatarAvailable: false } }
    }
    try {
      const avatarPath = resolveManagedAvatar(dependencies.getLibraryRoot(), identity.avatarRelPath, true)
      readValidatedAvatar(avatarPath)
      return { ok: true, value: { ...identity, avatarAvailable: true } }
    } catch {
      return { ok: true, value: { displayName: identity.displayName, avatarAvailable: false } }
    }
  } catch (error) {
    return fail(error)
  }
}

export async function setUserIdentity(
  input: UserIdentityInput,
  dependencies: ProfileDependencies
): Promise<FrontendIpcResult<UserIdentity>> {
  try {
    if (!input || typeof input !== 'object') throw new FrontendIpcException('INVALID_INPUT', 'identity is required')
    const displayName = validateDisplayName(input.displayName)
    const current = readPersistedIdentity(dependencies.getPreferences())
    let avatarRelPath = current.avatarRelPath
    let avatarAvailable = false
    if (input.avatarRelPath !== undefined) {
      if (typeof input.avatarRelPath !== 'string') throw new FrontendIpcException('INVALID_INPUT', 'avatarRelPath must be a string')
      if (!input.avatarRelPath) {
        avatarRelPath = undefined
      } else if (path.isAbsolute(input.avatarRelPath)) {
        avatarRelPath = await dependencies.withLibraryWriter(() =>
          importAvatar(dependencies.getLibraryRoot(), input.avatarRelPath!, dependencies.convertSvgToPng))
        avatarAvailable = true
      } else {
        const managedPath = resolveManagedAvatar(dependencies.getLibraryRoot(), input.avatarRelPath, true)
        readValidatedAvatar(managedPath)
        avatarRelPath = path.relative(dependencies.getLibraryRoot(), managedPath).split(path.sep).join('/')
        avatarAvailable = true
      }
    } else if (avatarRelPath) {
      // Editing only the name must not perpetuate a missing or escaped avatar.
      // Resolve it again and fall back to the default avatar if it is stale.
      try {
        const managedPath = resolveManagedAvatar(dependencies.getLibraryRoot(), avatarRelPath, true)
        readValidatedAvatar(managedPath)
        avatarRelPath = path.relative(dependencies.getLibraryRoot(), managedPath).split(path.sep).join('/')
        avatarAvailable = true
      } catch {
        avatarRelPath = undefined
      }
    }
    const persisted: PersistedIdentity = { displayName, ...(avatarRelPath ? { avatarRelPath } : {}) }
    await dependencies.updatePreferences({ userIdentity: persisted })
    return { ok: true, value: { ...persisted, avatarAvailable } }
  } catch (error) {
    return fail(error, 'OPERATION_FAILED')
  }
}

export async function selectProfileImage(
  dependencies: ProfileDependencies
): Promise<FrontendIpcResult<ImageSelectionResult>> {
  try {
    if (!dependencies.showOpenDialog) {
      throw new FrontendIpcException('WINDOW_UNAVAILABLE', 'Native image picker is unavailable')
    }
    const selection = await dependencies.showOpenDialog({
      properties: ['openFile'],
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'svg'] }]
    })
    const filePath = selection.filePaths[0]
    return {
      ok: true,
      value: selection.canceled || !filePath
        ? { canceled: true }
        : { canceled: false, filePath }
    }
  } catch (error) {
    return fail(error, 'OPERATION_FAILED')
  }
}

export async function getHarnessIconOverrides(
  dependencies: ProfileDependencies
): Promise<FrontendIpcResult<HarnessIconOverride[]>> {
  try {
    const persisted = readPersistedHarnessIconOverrides(dependencies.getPreferences())
    const overrides: HarnessIconOverride[] = []
    for (const [source, iconRelPath] of Object.entries(persisted)) {
      try {
        const managedPath = resolveManagedAvatar(dependencies.getLibraryRoot(), iconRelPath, true)
        readValidatedAvatar(managedPath)
        overrides.push({ source, iconRelPath, iconAvailable: true })
      } catch {
        overrides.push({ source, iconAvailable: false })
      }
    }
    return { ok: true, value: overrides }
  } catch (error) {
    return fail(error)
  }
}

export async function setHarnessIconOverride(
  input: HarnessIconOverrideInput,
  dependencies: ProfileDependencies
): Promise<FrontendIpcResult<HarnessIconOverride>> {
  try {
    if (!input || typeof input !== 'object') {
      throw new FrontendIpcException('INVALID_INPUT', 'harness icon input is required')
    }
    const source = validateHarnessSource(input.source)
    const current = readPersistedHarnessIconOverrides(dependencies.getPreferences())
    if (input.iconRelPath === undefined || input.iconRelPath === '') {
      delete current[source]
      await dependencies.updatePreferences({ harnessIconOverrides: current })
      return { ok: true, value: { source, iconAvailable: false } }
    }
    if (typeof input.iconRelPath !== 'string' || !path.isAbsolute(input.iconRelPath)) {
      throw new FrontendIpcException('INVALID_INPUT', 'A selected absolute image path is required')
    }
    const iconRelPath = await dependencies.withLibraryWriter(() =>
      importManagedImage(
        dependencies.getLibraryRoot(),
        input.iconRelPath!,
        `harness-${source}`,
        dependencies.convertSvgToPng
      ))
    current[source] = iconRelPath
    await dependencies.updatePreferences({ harnessIconOverrides: current })
    return { ok: true, value: { source, iconRelPath, iconAvailable: true } }
  } catch (error) {
    return fail(error, 'OPERATION_FAILED')
  }
}

function decodePng(base64: unknown): Buffer {
  if (typeof base64 !== 'string') throw new FrontendIpcException('INVALID_INPUT', 'PNG payload must be a base64 string')
  const value = base64.startsWith('data:image/png;base64,')
    ? base64.slice('data:image/png;base64,'.length)
    : base64
  if (!value) {
    throw new FrontendIpcException('INVALID_INPUT', 'PNG payload is not valid base64')
  }
  if (value.length > Math.ceil(MAX_SHARE_PNG_BYTES / 3) * 4 + 4) {
    throw new FrontendIpcException('FILE_TOO_LARGE', 'PNG must be 32 MiB or smaller')
  }
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new FrontendIpcException('INVALID_INPUT', 'PNG payload is not valid base64')
  }
  const buffer = Buffer.from(value, 'base64')
  if (buffer.length > MAX_SHARE_PNG_BYTES) throw new FrontendIpcException('FILE_TOO_LARGE', 'PNG must be 32 MiB or smaller')
  if (buffer.length < 8 || !buffer.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) {
    throw new FrontendIpcException('INVALID_IMAGE_FORMAT', 'Payload is not a PNG image')
  }
  return buffer
}

function suggestedPngName(input: unknown): string {
  const raw = typeof input === 'string' ? input.split(/[\\/]/).pop() || '' : ''
  const withoutExtension = raw.replace(/\.png$/i, '')
  const safe = withoutExtension
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 120)
  return `${safe || 'swob-share'}.png`
}

export interface ShareDependencies {
  showSaveDialog: (options: {
    title: string
    defaultPath: string
    filters: Array<{ name: string; extensions: string[] }>
  }) => Promise<{ canceled: boolean; filePath?: string }>
  writeFile: (filePath: string, data: Buffer, options: { mode: number }) => void | Promise<void>
}

export async function savePng(
  base64: unknown,
  suggestedName: unknown,
  dependencies: ShareDependencies
): Promise<FrontendIpcResult<ShareSavePngResult>> {
  try {
    const buffer = decodePng(base64)
    const dialogResult = await dependencies.showSaveDialog({
      title: '保存 PNG',
      defaultPath: suggestedPngName(suggestedName),
      filters: [{ name: 'PNG Image', extensions: ['png'] }]
    })
    if (dialogResult.canceled || !dialogResult.filePath) return { ok: true, value: { canceled: true } }
    const target = /\.png$/i.test(dialogResult.filePath) ? dialogResult.filePath : `${dialogResult.filePath}.png`
    await dependencies.writeFile(target, buffer, { mode: 0o600 })
    return { ok: true, value: { canceled: false, filePath: target } }
  } catch (error) {
    return fail(error, 'OPERATION_FAILED')
  }
}

interface ClipboardDependencies {
  createImage: (buffer: Buffer) => { isEmpty(): boolean }
  writeImage: (image: { isEmpty(): boolean }) => void
}

export function copyPngToClipboard(
  base64: unknown,
  dependencies: ClipboardDependencies
): FrontendIpcResult<ShareCopyPngResult> {
  try {
    const image = dependencies.createImage(decodePng(base64))
    if (image.isEmpty()) throw new FrontendIpcException('INVALID_IMAGE_FORMAT', 'Electron could not decode the PNG image')
    dependencies.writeImage(image)
    return { ok: true, value: { copied: true } }
  } catch (error) {
    return fail(error, error instanceof FrontendIpcException ? error.code : 'CLIPBOARD_FAILED')
  }
}

interface IpcHandleRegistrar {
  handle(channel: string, handler: (event: unknown, ...args: any[]) => unknown): void
}

export function registerFrontendIpc(options: {
  ipcMain: IpcHandleRegistrar
  profile: ProfileDependencies
  spotlight: {
    platform: NodeJS.Platform
    getWindow: () => ShadowWindow | null
    setPreference: (flag: boolean) => void
  }
  share: ShareDependencies & ClipboardDependencies
}): void {
  options.ipcMain.handle('spotlight:setNativeShadow', (_event, flag: unknown) => {
    const result = setNativeShadowPreference(flag, options.spotlight)
    if (result.ok) options.spotlight.setPreference(result.value.nativeShadow)
    return result
  })
  options.ipcMain.handle('profile:getUserIdentity', () => getUserIdentity(options.profile))
  options.ipcMain.handle('profile:setUserIdentity', (_event, input: UserIdentityInput) => setUserIdentity(input, options.profile))
  options.ipcMain.handle('profile:selectImage', () => selectProfileImage(options.profile))
  options.ipcMain.handle('profile:getHarnessIconOverrides', () => getHarnessIconOverrides(options.profile))
  options.ipcMain.handle('profile:setHarnessIconOverride', (_event, input: HarnessIconOverrideInput) =>
    setHarnessIconOverride(input, options.profile))
  options.ipcMain.handle('share:savePng', (_event, base64: unknown, suggestedName: unknown) => savePng(base64, suggestedName, options.share))
  options.ipcMain.handle('share:copyPngToClipboard', (_event, base64: unknown) => copyPngToClipboard(base64, options.share))
}
