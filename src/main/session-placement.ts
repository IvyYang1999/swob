/**
 * 会话落点决策（纯函数，无副作用，便于单测）。
 *
 * 设计目标：让 swob 库根可以安全地设为整个 Obsidian vault。
 * - 在 vault 内某项目目录里启动的会话 → 落进 `<cwd>/AI会话/`，
 *   于是它就直接出现在该项目的目录树里，无需软链接/别名。
 * - vault 外（或 vault 根、或忽略目录里）启动的会话 → 落进中央桶 `<root>/AI会话/`。
 *
 * 关键不变量：**任何会话都不会落在库根本身**——即便库根 = vault，
 * vault 外的会话也进 `<root>/AI会话/`，绝不污染 vault 根目录。
 */
import * as path from 'path'

/**
 * 默认不参与 swob 扫描/放置的目录名（任意层级匹配）。
 *
 * 只放**通用**的开发垃圾目录——绝不硬编码某个 vault 专属的目录名（如 wiki、clipii），
 * 否则开源给别人用时会莫名其妙地隐藏人家的目录。需要隐藏自己 vault 的目录，
 * 在该库的 `.swob-config.json` 里写 `ignoreDirs: [...]` 覆盖即可。
 */
export const DEFAULT_IGNORE_DIRS = ['node_modules', '.git']

/** 默认的会话归档子目录名。 */
export const SESSION_FOLDER = 'AI会话'

function isInside(parentDir: string, childPath: string): boolean {
  const rel = path.relative(parentDir, childPath)
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel)
}

/** 路径相对 root 的任一段命中忽略名单。 */
export function isIgnoredPath(p: string, root: string, ignore: Set<string>): boolean {
  const rel = path.relative(root, p)
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return false
  return rel.split(path.sep).some((seg) => ignore.has(seg))
}

/**
 * 决定会话应落在哪个「AI会话」父目录下。
 *
 * @param cwds    会话出现过的工作目录（取第一个有效值作为「启动目录」）
 * @param root    库根
 * @param ignore  忽略目录名集合
 * @param folder  归档子目录名，默认 `AI会话`
 * @returns       会话目录应创建在此父目录下
 */
export function resolveSessionParent(
  cwds: string[] | undefined,
  root: string,
  ignore: Set<string> = new Set(DEFAULT_IGNORE_DIRS),
  folder: string = SESSION_FOLDER,
  centralSubfolder?: string
): string {
  const rootResolved = path.resolve(root)
  // 若库根本身就是「AI会话」目录（迁移前的旧配置），中央桶 = 库根，避免 AI会话/AI会话 嵌套
  const centralBase =
    path.basename(rootResolved) === folder ? rootResolved : path.join(root, folder)
  // 中央桶里新会话可再落进一个子目录（如 单轮会话/未分组），让它直接出现在 UI 底部对应区
  const central = centralSubfolder ? path.join(centralBase, centralSubfolder) : centralBase
  const launch = (cwds || []).find((c) => c && c.trim())
  if (!launch) return central

  const cwd = path.resolve(launch)
  if (
    isInside(rootResolved, cwd) &&
    cwd !== rootResolved &&
    !isIgnoredPath(cwd, rootResolved, ignore)
  ) {
    return path.join(cwd, folder)
  }
  return central
}
