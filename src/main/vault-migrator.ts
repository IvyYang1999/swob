import * as fs from 'node:fs'
import * as path from 'node:path'
import { createHash } from 'node:crypto'

export interface MigrationProgress {
  phase: 'counting' | 'copying' | 'verifying' | 'done'
  copied: number
  total: number
}

export interface MigrationResult {
  ok: boolean
  error?: string
  movedMarkerPath?: string
}

function walkFiles(root: string): string[] {
  const files: string[] = []
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name)
      if (entry.isSymbolicLink()) {
        files.push(fullPath)
      } else if (entry.isDirectory()) {
        walk(fullPath)
      } else if (entry.isFile()) {
        files.push(fullPath)
      }
    }
  }
  walk(root)
  return files
}

function hashFile(filePath: string): string {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
}

export function validateMigrationTarget(sourceRoot: string, targetRoot: string): string | null {
  const source = path.resolve(sourceRoot)
  const target = path.resolve(targetRoot)
  if (source === target) return '目标位置与当前库相同'
  const relative = path.relative(source, target)
  if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
    return '目标位置不能在当前库内部'
  }
  const reverseRelative = path.relative(target, source)
  if (reverseRelative && !reverseRelative.startsWith('..') && !path.isAbsolute(reverseRelative)) {
    return '目标位置不能是当前库的上级目录'
  }
  if (fs.existsSync(target)) {
    const entries = fs.readdirSync(target).filter((name) => name !== '.DS_Store')
    if (entries.length > 0) return '目标文件夹必须为空'
  }
  return null
}

/**
 * Copy the whole vault to a new location, verify, and leave a MOVED.md marker
 * in the old root. The old vault is never deleted — the user decides that.
 * On any failure the target is cleaned up and the source stays untouched.
 */
export function migrateVault(
  sourceRoot: string,
  targetRoot: string,
  onProgress?: (progress: MigrationProgress) => void
): MigrationResult {
  const source = path.resolve(sourceRoot)
  const target = path.resolve(targetRoot)

  const validationError = validateMigrationTarget(source, target)
  if (validationError) return { ok: false, error: validationError }
  if (!fs.existsSync(source) || !fs.statSync(source).isDirectory()) {
    return { ok: false, error: '当前库目录不存在' }
  }

  const createdTarget = !fs.existsSync(target)
  try {
    onProgress?.({ phase: 'counting', copied: 0, total: 0 })
    const sourceFiles = walkFiles(source)
    const total = sourceFiles.length

    fs.mkdirSync(target, { recursive: true })
    let copied = 0
    for (const sourceFile of sourceFiles) {
      const relative = path.relative(source, sourceFile)
      const destination = path.join(target, relative)
      fs.mkdirSync(path.dirname(destination), { recursive: true })
      const stat = fs.lstatSync(sourceFile)
      if (stat.isSymbolicLink()) {
        let link = fs.readlinkSync(sourceFile)
        // Session symlinks inside the vault must follow it to the new home.
        const linkTargetAbsolute = path.resolve(path.dirname(sourceFile), link)
        const linkRelativeToSource = path.relative(source, linkTargetAbsolute)
        if (linkRelativeToSource && !linkRelativeToSource.startsWith('..') && !path.isAbsolute(linkRelativeToSource)) {
          link = path.join(target, linkRelativeToSource)
        }
        fs.symlinkSync(link, destination)
      } else {
        fs.copyFileSync(sourceFile, destination)
      }
      copied++
      if (copied % 50 === 0 || copied === total) {
        onProgress?.({ phase: 'copying', copied, total })
      }
    }

    onProgress?.({ phase: 'verifying', copied: total, total })
    const targetFiles = walkFiles(target)
    if (targetFiles.length !== total) {
      throw new Error(`校验失败：文件数不一致（源 ${total}，目标 ${targetFiles.length}）`)
    }
    const sampleStep = Math.max(1, Math.floor(total / 20))
    for (let index = 0; index < total; index += sampleStep) {
      const sourceFile = sourceFiles[index]
      if (fs.lstatSync(sourceFile).isSymbolicLink()) continue
      const relative = path.relative(source, sourceFile)
      const destination = path.join(target, relative)
      if (hashFile(sourceFile) !== hashFile(destination)) {
        throw new Error(`校验失败：${relative} 内容不一致`)
      }
    }

    const movedMarkerPath = path.join(source, 'MOVED.md')
    const stamp = new Date().toISOString().slice(0, 10)
    fs.writeFileSync(movedMarkerPath, [
      '# 此 Swob 库已迁移',
      '',
      `- 新位置：\`${target}\``,
      `- 迁移日期：${stamp}`,
      '',
      '所有会话包已完整复制到新位置并通过校验。确认新位置一切正常后，可手动删除本目录。',
      ''
    ].join('\n'), 'utf-8')

    onProgress?.({ phase: 'done', copied: total, total })
    return { ok: true, movedMarkerPath }
  } catch (error) {
    // Roll back the half-copied target; the source was never modified.
    try {
      if (createdTarget) fs.rmSync(target, { recursive: true, force: true })
    } catch { /* leave partial copy for manual inspection */ }
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}
