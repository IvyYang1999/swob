import * as fs from 'node:fs'
import * as path from 'node:path'
import {
  createDefaultDashboardLayout,
  isDashboardLayoutConfig,
  type DashboardLayoutConfig
} from '../shared/registry/builtin-widgets'

const DASHBOARD_DIRECTORY = '.swob'
const DASHBOARD_FILE = 'dashboard.json'

export { createDefaultDashboardLayout }

export function getDashboardLayoutPath(libraryRoot: string): string {
  return path.join(libraryRoot, DASHBOARD_DIRECTORY, DASHBOARD_FILE)
}

function isSymbolicLink(target: string): boolean {
  try {
    return fs.lstatSync(target).isSymbolicLink()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

export function readDashboardLayout(libraryRoot: string): DashboardLayoutConfig {
  const directory = path.join(libraryRoot, DASHBOARD_DIRECTORY)
  const filePath = getDashboardLayoutPath(libraryRoot)
  try {
    if (isSymbolicLink(directory) || isSymbolicLink(filePath)) return createDefaultDashboardLayout()
    const stats = fs.statSync(filePath)
    if (!stats.isFile()) return createDefaultDashboardLayout()
    const parsed: unknown = JSON.parse(fs.readFileSync(filePath, 'utf8'))
    return isDashboardLayoutConfig(parsed) ? structuredClone(parsed) : createDefaultDashboardLayout()
  } catch {
    return createDefaultDashboardLayout()
  }
}

function ensureSafeDashboardDirectory(libraryRoot: string): string {
  const directory = path.join(libraryRoot, DASHBOARD_DIRECTORY)
  if (isSymbolicLink(directory)) throw new Error('Refusing to write dashboard layout through symbolic link')
  try {
    const stats = fs.statSync(directory)
    if (!stats.isDirectory()) throw new Error('Dashboard configuration path is not a directory')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    fs.mkdirSync(directory, { recursive: false, mode: 0o700 })
  }
  return directory
}

export function writeDashboardLayout(
  libraryRoot: string,
  layout: DashboardLayoutConfig
): DashboardLayoutConfig {
  if (!isDashboardLayoutConfig(layout)) throw new Error('Invalid dashboard layout')
  const directory = ensureSafeDashboardDirectory(libraryRoot)
  const filePath = getDashboardLayoutPath(libraryRoot)
  if (isSymbolicLink(filePath)) throw new Error('Refusing to write dashboard layout through symbolic link')

  const tempPath = path.join(directory, `.dashboard-${process.pid}-${Date.now()}.tmp`)
  let descriptor: number | undefined
  try {
    descriptor = fs.openSync(tempPath, 'wx', 0o600)
    fs.writeFileSync(descriptor, `${JSON.stringify(layout, null, 2)}\n`, 'utf8')
    fs.fsyncSync(descriptor)
    fs.closeSync(descriptor)
    descriptor = undefined
    fs.renameSync(tempPath, filePath)
    fs.chmodSync(filePath, 0o600)
  } catch (error) {
    if (descriptor !== undefined) fs.closeSync(descriptor)
    try {
      fs.unlinkSync(tempPath)
    } catch {
      // The temporary file may not have been created or may already have been renamed.
    }
    throw error
  }

  return structuredClone(layout)
}
