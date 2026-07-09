#!/usr/bin/env node

import {
  loadAllSessions,
  loadSessionDetail,
  findAllSessionFiles,
  parseSessionFile,
  buildSessionSummary
} from '../main/session-loader'
import {
  initLibrary,
  scanLibrary,
  libraryTreeToConfig,
  loadLibraryConfig,
  saveLibraryConfig,
  createLibraryFolder,
  renameLibraryFolder,
  deleteLibraryFolder,
  moveSessionToFolder,
  setSessionMetaInLibrary,
  resolveFolderPath,
  getLibraryRoot,
  getSessionDirPath,
  getSessionMdPath,
  rebuildAllTranscripts
} from '../main/library-manager'
import { loadConfig, saveConfig } from '../main/config-store'
import { spotlightSearch } from '../main/spotlight-search'
import { buildInsights } from '../main/insights'
import type { SessionSummary } from '../main/types'
import { execSync } from 'child_process'

// ── Helpers ────────────────────────────────────────────────────────

function out(data: unknown): void {
  process.stdout.write(JSON.stringify(data, null, 2) + '\n')
}

function err(message: string, code = 1): never {
  process.stderr.write(JSON.stringify({ error: message }) + '\n')
  process.exit(code)
}

function parseArgs(argv: string[]): { cmd: string[]; flags: Record<string, string | true> } {
  const cmd: string[] = []
  const flags: Record<string, string | true> = {}
  let i = 0
  while (i < argv.length) {
    const arg = argv[i]
    if (arg.startsWith('--')) {
      const key = arg.slice(2)
      const next = argv[i + 1]
      if (next && !next.startsWith('--')) {
        flags[key] = next
        i += 2
      } else {
        flags[key] = true
        i += 1
      }
    } else {
      cmd.push(arg)
      i += 1
    }
  }
  return { cmd, flags }
}

function detectActiveSessionsFromProcesses(): Set<string> {
  try {
    const stdout = execSync('ps -eo command', { encoding: 'utf-8', timeout: 3000 })
    const active = new Set<string>()
    for (const line of stdout.split('\n')) {
      if (!line.includes('claude')) continue
      const match = line.match(/--resume\s+(\S+)/)
      if (match) active.add(match[1])
    }
    return active
  } catch {
    return new Set()
  }
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

function formatTime(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`
  return `${(ms / 3_600_000).toFixed(1)}h`
}

// ── Init ───────────────────────────────────────────────────────────

initLibrary()
scanLibrary()

// ── Commands ───────────────────────────────────────────────────────

async function cmdSearch(query: string, flags: Record<string, string | true>): Promise<void> {
  const sessions = await loadAllSessions()
  const config = (() => {
    const tree = scanLibrary()
    return libraryTreeToConfig(tree)
  })()
  const folderMap = new Map<string, string>()
  for (const folder of config.folders) {
    for (const sid of folder.sessionIds) {
      folderMap.set(sid, folder.name)
    }
  }
  const limit = flags.limit ? parseInt(String(flags.limit), 10) : 20
  const results = spotlightSearch(query, sessions, {
    sessionMeta: config.sessionMeta || {},
    folderMap
  }, limit)

  out(results.map(r => ({
    sessionId: r.session.sessionId,
    title: r.customTitle || r.session.firstUserMessage?.slice(0, 80),
    folder: r.folderName || null,
    source: r.session.source || 'claude-code',
    updatedAt: r.session.updatedAt,
    turnCount: r.session.turnCount,
    tokens: r.session.tokenUsage.inputTokens + r.session.tokenUsage.outputTokens,
    score: Math.round(r.score),
    matchedFields: r.matchedFields
  })))
}

async function cmdList(flags: Record<string, string | true>): Promise<void> {
  const sessions = await loadAllSessions()
  const config = (() => {
    const tree = scanLibrary()
    return libraryTreeToConfig(tree)
  })()

  let filtered = sessions

  if (flags.folder) {
    const folderName = String(flags.folder).toLowerCase()
    const folder = config.folders.find(f => f.name.toLowerCase() === folderName)
    if (!folder) err(`文件夹 "${flags.folder}" 不存在`)
    const idSet = new Set(folder.sessionIds)
    filtered = filtered.filter(s => idSet.has(s.sessionId))
  }

  if (flags.source) {
    const src = String(flags.source).toLowerCase()
    filtered = filtered.filter(s => (s.source || 'claude-code') === src)
  }

  if (flags.project) {
    const proj = String(flags.project).toLowerCase()
    filtered = filtered.filter(s =>
      s.cwds.some(c => c.toLowerCase().includes(proj)) ||
      s.projectPath.toLowerCase().includes(proj)
    )
  }

  const limit = flags.limit ? parseInt(String(flags.limit), 10) : 50
  filtered = filtered.slice(0, limit)

  const sessionMeta = config.sessionMeta || {}
  const folderMap = new Map<string, string>()
  for (const folder of config.folders) {
    for (const sid of folder.sessionIds) {
      folderMap.set(sid, folder.name)
    }
  }

  out(filtered.map(s => ({
    sessionId: s.sessionId,
    title: sessionMeta[s.sessionId]?.customTitle || s.firstUserMessage?.slice(0, 80),
    folder: folderMap.get(s.sessionId) || null,
    source: s.source || 'claude-code',
    project: s.cwds[0]?.split('/').pop() || '',
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    turnCount: s.turnCount,
    tokens: s.tokenUsage.inputTokens + s.tokenUsage.outputTokens,
    isActive: false
  })))
}

async function cmdShow(sessionId: string): Promise<void> {
  const sessions = await loadAllSessions()
  const session = sessions.find(s => s.sessionId === sessionId || s.id === sessionId)
  if (!session) err(`Session "${sessionId}" 不存在`)

  const detail = await loadSessionDetail(
    session.filePath,
    session.allFilePaths,
    session.branchParentFilePaths,
    session.branchPointUuid,
    session.branchLeafUuid
  )
  if (!detail) err(`无法加载 session "${sessionId}" 的详情`)

  const config = (() => {
    const tree = scanLibrary()
    return libraryTreeToConfig(tree)
  })()
  const meta = config.sessionMeta?.[session.sessionId]

  out({
    sessionId: detail.sessionId,
    title: meta?.customTitle || detail.firstUserMessage?.slice(0, 80),
    source: detail.source || 'claude-code',
    createdAt: detail.createdAt,
    updatedAt: detail.updatedAt,
    turnCount: detail.turnCount,
    compactCount: detail.compactCount,
    cwds: detail.cwds,
    version: detail.version,
    permissionMode: detail.permissionMode,
    tokens: {
      input: detail.tokenUsage.inputTokens,
      output: detail.tokenUsage.outputTokens,
      cacheCreation: detail.tokenUsage.cacheCreationTokens,
      cacheRead: detail.tokenUsage.cacheReadTokens
    },
    models: detail.models,
    toolUsage: detail.toolUsage,
    messages: detail.messages.map(m => ({
      uuid: m.uuid,
      type: m.type,
      timestamp: m.timestamp,
      text: m.textContent.slice(0, 500),
      toolCalls: m.toolCalls.map(t => t.name),
      isPreCompact: m.isPreCompact,
      isSidechain: m.isSidechain
    }))
  })
}

function cmdResume(sessionId: string, flags: Record<string, string | true>): void {
  const source = String(flags.source || 'claude-code')
  const skipPermissions = flags['skip-permissions'] === true

  let cmd: string
  if (source === 'codex') {
    cmd = `codex resume ${sessionId}`
  } else if (source === 'cursor') {
    cmd = `cursor agent --resume ${sessionId}`
  } else if (source === 'opencode') {
    cmd = `opencode --session ${sessionId}`
  } else {
    cmd = skipPermissions
      ? `claude --dangerously-skip-permissions --resume ${sessionId}`
      : `claude --resume ${sessionId}`
  }

  if (flags.cwd) {
    cmd = `cd ${JSON.stringify(String(flags.cwd))} && ${cmd}`
  }

  out({ command: cmd })
}

function cmdFolders(): void {
  const tree = scanLibrary()
  const config = libraryTreeToConfig(tree)

  interface FolderNode {
    id: string
    name: string
    parentId: string | null
    sessionCount: number
    children?: FolderNode[]
  }

  const folderMap = new Map<string, FolderNode>()
  for (const f of config.folders) {
    folderMap.set(f.id, {
      id: f.id,
      name: f.name,
      parentId: f.parentId || null,
      sessionCount: f.sessionIds.length
    })
  }

  const roots: FolderNode[] = []
  for (const node of folderMap.values()) {
    if (node.parentId && folderMap.has(node.parentId)) {
      const parent = folderMap.get(node.parentId)!
      if (!parent.children) parent.children = []
      parent.children.push(node)
    } else {
      roots.push(node)
    }
  }

  out(roots)
}

function cmdFolderCreate(name: string, flags: Record<string, string | true>): void {
  const parentId = flags.parent ? String(flags.parent) : undefined
  const parentPath = parentId ? resolveFolderPath(parentId) : undefined
  createLibraryFolder(name, parentPath)
  const tree = scanLibrary()
  const config = libraryTreeToConfig(tree)
  const created = config.folders.find(f => f.name === name)
  out({ success: true, folder: created ? { id: created.id, name: created.name } : null })
}

function cmdFolderRename(folderId: string, newName: string): void {
  const folderPath = resolveFolderPath(folderId)
  renameLibraryFolder(folderPath, newName)
  scanLibrary()
  out({ success: true })
}

function cmdFolderDelete(folderId: string): void {
  const folderPath = resolveFolderPath(folderId)
  deleteLibraryFolder(folderPath)
  scanLibrary()
  out({ success: true })
}

async function cmdMove(sessionId: string, folderId: string): Promise<void> {
  const folderPath = resolveFolderPath(folderId)
  moveSessionToFolder(sessionId, folderPath)
  scanLibrary()
  out({ success: true })
}

function cmdRename(sessionId: string, title: string): void {
  setSessionMetaInLibrary(sessionId, { customTitle: title })
  scanLibrary()
  out({ success: true })
}

async function cmdInsights(flags: Record<string, string | true>): Promise<void> {
  const sessions = await loadAllSessions()
  const tree = scanLibrary()
  const config = libraryTreeToConfig(tree)
  const sessionTimes = new Map<string, number>()
  for (const s of sessions) {
    if (s.estimatedTime) sessionTimes.set(s.sessionId, s.estimatedTime)
  }
  const insights = buildInsights(sessions, config.folders, sessionTimes)

  if (flags.summary === true || !flags.json) {
    out({
      totalSessions: insights.totalSessions,
      totalTurns: insights.totalTurns,
      totalTokens: insights.totalTokens,
      totalTime: insights.totalTime,
      totalTimeFormatted: formatTime(insights.totalTime),
      activeDays: insights.activeDays,
      bySource: insights.bySource.filter(s => s.sessionCount > 0).map(s => ({
        source: s.source,
        label: s.label,
        sessions: s.sessionCount,
        tokens: s.totalTokens,
        tokensFormatted: formatTokens(s.totalTokens)
      })),
      byModel: insights.byModel.slice(0, 10).map(m => ({
        model: m.model,
        tokens: m.totalTokens,
        tokensFormatted: formatTokens(m.totalTokens),
        sessions: m.sessionCount
      })),
      topProjects: insights.byProject.slice(0, 10).map(p => ({
        project: p.project,
        path: p.fullPath,
        sessions: p.sessionCount,
        tokens: p.totalTokens,
        tokensFormatted: formatTokens(p.totalTokens)
      }))
    })
    return
  }

  out(insights)
}

function cmdConfigGet(key?: string): void {
  const libConfig = loadLibraryConfig()
  if (!key) {
    out({
      libraryRoot: getLibraryRoot(),
      preferences: libConfig.preferences
    })
    return
  }
  const prefs = libConfig.preferences as Record<string, unknown>
  if (key === 'libraryRoot') {
    out({ libraryRoot: getLibraryRoot() })
  } else if (key in prefs) {
    out({ [key]: prefs[key] })
  } else {
    err(`未知的配置项: ${key}`)
  }
}

function cmdConfigSet(key: string, value: string): void {
  const libConfig = loadLibraryConfig()
  const prefs = libConfig.preferences as Record<string, unknown>
  if (value === 'true') prefs[key] = true
  else if (value === 'false') prefs[key] = false
  else prefs[key] = value
  saveLibraryConfig(libConfig)
  out({ success: true, [key]: prefs[key] })
}

function cmdActive(): void {
  const active = detectActiveSessionsFromProcesses()
  out({ activeSessionIds: Array.from(active) })
}

async function cmdTranscript(args: string[], flags: Record<string, string | true>): Promise<void> {
  if (args[0] !== 'rebuild' || flags.all !== true) {
    err('用法: swob transcript rebuild --all [--dry-run] [--missing-only]')
  }
  const result = await rebuildAllTranscripts({
    dryRun: flags['dry-run'] === true,
    missingOnly: flags['missing-only'] === true
  })
  out(result)
}

async function cmdInstall(): Promise<void> {
  const fs = await import('fs')
  const path = await import('path')
  const os = await import('os')

  // 1. Install CLI symlink
  const cliSource = path.join(__dirname, 'index.js')
  const cliTarget = '/usr/local/bin/swob'
  const wrapperScript = `#!/bin/bash\nexec node "${cliSource}" "$@"\n`
  const wrapperPath = path.join(os.homedir(), '.claude-session-manager', 'swob-cli.sh')

  const csmDir = path.join(os.homedir(), '.claude-session-manager')
  if (!fs.existsSync(csmDir)) fs.mkdirSync(csmDir, { recursive: true })
  fs.writeFileSync(wrapperPath, wrapperScript, { mode: 0o755 })

  let cliInstalled = false
  try {
    if (fs.existsSync(cliTarget)) fs.unlinkSync(cliTarget)
    fs.symlinkSync(wrapperPath, cliTarget)
    cliInstalled = true
  } catch {
    // Needs sudo, fall back to advice
    cliInstalled = false
  }

  // 2. Install skill
  const skillDir = path.join(os.homedir(), '.claude', 'skills', 'swob')
  if (!fs.existsSync(skillDir)) fs.mkdirSync(skillDir, { recursive: true })
  const skillPath = path.join(skillDir, 'SKILL.md')
  fs.writeFileSync(skillPath, generateSkillContent(), 'utf-8')

  out({
    cliInstalled,
    cliPath: cliInstalled ? cliTarget : null,
    cliManualInstall: cliInstalled ? null : `sudo ln -sf "${wrapperPath}" ${cliTarget}`,
    skillInstalled: true,
    skillPath
  })
}

function generateSkillContent(): string {
  return `# Swob CLI — Agent Skill

Swob 是 Claude Code / Codex / Cursor 的会话管理工具。通过 \`swob\` CLI 你可以搜索、浏览、恢复和整理用户的所有 AI 编程助手聊天记录。

## 使用前提

用户已安装 Swob 桌面应用并执行过 \`swob install\`。

## 命令参考

所有命令输出 JSON，可直接解析。

### 搜索 session

\`\`\`bash
swob search "关键词"
swob search "项目名" --limit 10
\`\`\`

返回匹配的 session 列表，按相关性排序。支持中英文、项目名、文件夹名、时间（今天/昨天/本周）、来源（cc/codex/cursor/opencode）。

### 列出 session

\`\`\`bash
swob list
swob list --folder "项目名"
swob list --source claude-code
swob list --project swob
swob list --limit 20
\`\`\`

### 查看 session 详情

\`\`\`bash
swob show <sessionId>
\`\`\`

返回完整的 session 信息，包括消息列表、工具调用、token 统计。

### 恢复 session（获取 resume 命令）

\`\`\`bash
swob resume <sessionId>
swob resume <sessionId> --skip-permissions
swob resume <sessionId> --cwd /path/to/project
\`\`\`

返回 \`{ "command": "claude --resume ..." }\`，你可以直接执行该命令。

### 列出文件夹

\`\`\`bash
swob folders
\`\`\`

返回文件夹树形结构。

### 创建文件夹

\`\`\`bash
swob folder create "文件夹名"
swob folder create "子文件夹" --parent "父文件夹id"
\`\`\`

### 重命名文件夹

\`\`\`bash
swob folder rename <folderId> "新名称"
\`\`\`

### 删除文件夹

\`\`\`bash
swob folder delete <folderId>
\`\`\`

### 移动 session 到文件夹

\`\`\`bash
swob move <sessionId> <folderId>
\`\`\`

### 重命名 session

\`\`\`bash
swob rename <sessionId> "新标题"
\`\`\`

### 查看统计数据

\`\`\`bash
swob insights
swob insights --json
\`\`\`

返回 token 消耗、活跃天数、项目排行、模型使用等统计。

### 查看/修改设置

\`\`\`bash
swob config get
swob config get terminalApp
swob config set terminalApp iTerm2
swob config set defaultViewMode compact
\`\`\`

### 查看活跃 session

\`\`\`bash
swob active
\`\`\`

### 安装/更新 CLI 和 Skill

\`\`\`bash
swob install
\`\`\`

## 典型工作流

### 整理某个项目的所有 session

1. \`swob list --project myproject\` 找到所有相关 session
2. \`swob folders\` 查看现有文件夹
3. \`swob folder create "myproject"\` 创建文件夹（如不存在）
4. 对每个 session 执行 \`swob move <sessionId> <folderId>\`
5. 可选：\`swob rename <sessionId> "描述性标题"\` 重命名

### 快速找到并恢复之前的对话

1. \`swob search "我在做的事情"\` 搜索
2. 从结果中找到目标 sessionId
3. \`swob resume <sessionId>\` 获取恢复命令
4. 执行返回的命令

### 查看工作统计

\`swob insights\` 查看总览，包括 token 消耗和活跃时间。
`
}

// ── Main ───────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { cmd, flags } = parseArgs(process.argv.slice(2))

  if (cmd.length === 0 || flags.help === true) {
    process.stdout.write(`Swob CLI — AI 编程助手会话管理

用法: swob <命令> [参数] [选项]

命令:
  search <query>              搜索 session
  list                        列出 session
  show <sessionId>            查看 session 详情
  resume <sessionId>          获取 resume 命令
  folders                     列出所有文件夹
  folder create <name>        创建文件夹
  folder rename <id> <name>   重命名文件夹
  folder delete <id>          删除文件夹
  move <sessionId> <folderId> 移动 session 到文件夹
  rename <sessionId> <title>  重命名 session
  insights                    查看统计数据
  config get [key]            读取设置
  config set <key> <value>    修改设置
  active                      列出活跃 session
  transcript rebuild --all    强制重生成 Library transcript
  install                     安装/更新 CLI 和 Skill

选项:
  --help                      显示帮助
  --limit <n>                 限制结果数量
  --folder <name>             按文件夹过滤
  --source <source>           按来源过滤 (claude-code/codex/cursor/opencode)
  --project <name>            按项目过滤
  --json                      输出完整 JSON
  --skip-permissions          resume 时跳过权限
  --cwd <path>                resume 时指定工作目录
  --parent <id>               创建子文件夹时指定父文件夹
  --dry-run                   transcript rebuild 只统计不写入
  --missing-only              transcript rebuild 只补缺失的 transcript.md
`)
    process.exit(0)
  }

  const command = cmd[0]

  try {
    switch (command) {
      case 'search':
        if (!cmd[1]) err('缺少搜索关键词。用法: swob search <query>')
        await cmdSearch(cmd.slice(1).join(' '), flags)
        break

      case 'list':
        await cmdList(flags)
        break

      case 'show':
        if (!cmd[1]) err('缺少 sessionId。用法: swob show <sessionId>')
        await cmdShow(cmd[1])
        break

      case 'resume':
        if (!cmd[1]) err('缺少 sessionId。用法: swob resume <sessionId>')
        cmdResume(cmd[1], flags)
        break

      case 'folders':
        cmdFolders()
        break

      case 'folder':
        if (cmd[1] === 'create') {
          if (!cmd[2]) err('缺少文件夹名。用法: swob folder create <name>')
          cmdFolderCreate(cmd.slice(2).join(' '), flags)
        } else if (cmd[1] === 'rename') {
          if (!cmd[2] || !cmd[3]) err('用法: swob folder rename <id> <name>')
          cmdFolderRename(cmd[2], cmd.slice(3).join(' '))
        } else if (cmd[1] === 'delete') {
          if (!cmd[2]) err('缺少文件夹 ID。用法: swob folder delete <id>')
          cmdFolderDelete(cmd[2])
        } else {
          err(`未知的 folder 子命令: ${cmd[1]}`)
        }
        break

      case 'move':
        if (!cmd[1] || !cmd[2]) err('用法: swob move <sessionId> <folderId>')
        await cmdMove(cmd[1], cmd[2])
        break

      case 'rename':
        if (!cmd[1] || !cmd[2]) err('用法: swob rename <sessionId> <title>')
        cmdRename(cmd[1], cmd.slice(2).join(' '))
        break

      case 'insights':
        await cmdInsights(flags)
        break

      case 'config':
        if (cmd[1] === 'get') {
          cmdConfigGet(cmd[2])
        } else if (cmd[1] === 'set') {
          if (!cmd[2] || !cmd[3]) err('用法: swob config set <key> <value>')
          cmdConfigSet(cmd[2], cmd.slice(3).join(' '))
        } else {
          err(`未知的 config 子命令: ${cmd[1]}`)
        }
        break

      case 'active':
        cmdActive()
        break

      case 'transcript':
        await cmdTranscript(cmd.slice(1), flags)
        break

      case 'install':
        await cmdInstall()
        break

      default:
        err(`未知命令: ${command}。运行 swob --help 查看帮助。`)
    }
  } catch (e) {
    err(e instanceof Error ? e.message : String(e))
  }
}

main()
