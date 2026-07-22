import { spawn, execFile, type ChildProcess } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { terminateChildProcess } from './child-process-termination'

/**
 * Global agent engine: reuse the user's installed Claude Code CLI in headless
 * mode instead of shipping our own agent loop (yyt 2026-07-22 拍板①).
 * Tools are whitelisted to the swob CLI only, so the agent can query and
 * organize sessions but cannot touch anything else on the machine.
 */

export type AgentStreamEvent =
  | { type: 'init'; sessionId: string; model?: string }
  | { type: 'assistant-text'; text: string }
  | { type: 'tool-use'; name: string; summary: string }
  | { type: 'result'; ok: boolean; durationMs?: number; costUsd?: number; error?: string }

export interface AgentEngineStatus {
  available: boolean
  binaryPath?: string
  reason?: string
}

const CLI_CANDIDATES = [
  path.join(os.homedir(), '.local', 'bin', 'claude'),
  '/opt/homebrew/bin/claude',
  '/usr/local/bin/claude'
]

let cachedBinary: string | null | undefined

function resolveClaudeBinary(): Promise<string | null> {
  if (cachedBinary !== undefined) return Promise.resolve(cachedBinary)
  for (const candidate of CLI_CANDIDATES) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK)
      cachedBinary = candidate
      return Promise.resolve(candidate)
    } catch { /* try next */ }
  }
  return new Promise((resolve) => {
    execFile('/bin/zsh', ['-lc', 'command -v claude'], { timeout: 5000 }, (error, stdout) => {
      const found = !error && stdout.trim() ? stdout.trim().split('\n')[0] : null
      cachedBinary = found
      resolve(found)
    })
  })
}

export async function getAgentEngineStatus(): Promise<AgentEngineStatus> {
  const binary = await resolveClaudeBinary()
  if (!binary) {
    return { available: false, reason: '未检测到 Claude Code CLI(claude)。全局助手第一版依赖它作为引擎。' }
  }
  return { available: true, binaryPath: binary }
}

export function getAgentWorkspaceDir(): string {
  const dir = path.join(os.homedir(), '.claude-session-manager', 'agent')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

function buildSystemPrompt(libraryRoot: string | null): string {
  return [
    '你是 Swob 助手,一个管理用户 AI 编程会话历史的小窗助手。',
    '你唯一的工具是 swob CLI(已在白名单内):先跑 `swob --help --json` 了解全部命令。',
    '常用:swob search/list/grep 查会话,swob insights --json 看统计,swob move/rename 整理(改动类操作要先向用户确认)。',
    libraryRoot ? `用户的会话库(vault)在:${libraryRoot}` : '',
    '用中文回答,简洁直接;数字要说明口径;查不到就说查不到,不编造。'
  ].filter(Boolean).join('\n')
}

interface RunTurnOptions {
  prompt: string
  resumeSessionId?: string
  libraryRoot: string | null
  onEvent: (event: AgentStreamEvent) => void
}

export interface RunningTurn {
  cancel: () => void
  shutdown: () => Promise<void>
  done: Promise<void>
}

function summarizeToolInput(input: unknown): string {
  if (input && typeof input === 'object' && typeof (input as { command?: unknown }).command === 'string') {
    return String((input as { command: string }).command).slice(0, 120)
  }
  return ''
}

function handleStreamLine(line: string, onEvent: RunTurnOptions['onEvent']): void {
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(line)
  } catch {
    return
  }
  if (parsed.type === 'system' && parsed.subtype === 'init' && typeof parsed.session_id === 'string') {
    onEvent({ type: 'init', sessionId: parsed.session_id, model: typeof parsed.model === 'string' ? parsed.model : undefined })
    return
  }
  if (parsed.type === 'assistant') {
    const message = parsed.message as { content?: Array<Record<string, unknown>> } | undefined
    for (const part of message?.content || []) {
      if (part.type === 'text' && typeof part.text === 'string' && part.text.trim()) {
        onEvent({ type: 'assistant-text', text: part.text })
      } else if (part.type === 'tool_use' && typeof part.name === 'string') {
        onEvent({ type: 'tool-use', name: part.name, summary: summarizeToolInput(part.input) })
      }
    }
    return
  }
  if (parsed.type === 'result') {
    onEvent({
      type: 'result',
      ok: parsed.subtype === 'success',
      durationMs: typeof parsed.duration_ms === 'number' ? parsed.duration_ms : undefined,
      costUsd: typeof parsed.total_cost_usd === 'number' ? parsed.total_cost_usd : undefined,
      error: parsed.subtype !== 'success' && typeof parsed.result === 'string' ? parsed.result : undefined
    })
  }
}

export async function runAgentTurn(options: RunTurnOptions): Promise<RunningTurn | { error: string }> {
  const binary = await resolveClaudeBinary()
  if (!binary) return { error: '未检测到 Claude Code CLI(claude)' }

  const args = [
    '-p', options.prompt,
    '--output-format', 'stream-json',
    '--verbose',
    '--allowedTools', 'Bash(swob:*)',
    '--append-system-prompt', buildSystemPrompt(options.libraryRoot)
  ]
  if (options.resumeSessionId) args.push('--resume', options.resumeSessionId)

  let child: ChildProcess & { stdout: NonNullable<ChildProcess['stdout']>; stderr: NonNullable<ChildProcess['stderr']> }
  try {
    child = spawn(binary, args, {
      cwd: getAgentWorkspaceDir(),
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe']
    })
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }

  let buffered = ''
  let sawResult = false
  child.stdout.setEncoding('utf-8')
  child.stdout.on('data', (chunk: string) => {
    buffered += chunk
    let newline = buffered.indexOf('\n')
    while (newline >= 0) {
      const line = buffered.slice(0, newline).trim()
      buffered = buffered.slice(newline + 1)
      if (line) {
        if (line.includes('"type":"result"')) sawResult = true
        handleStreamLine(line, options.onEvent)
      }
      newline = buffered.indexOf('\n')
    }
  })

  let stderrTail = ''
  child.stderr.setEncoding('utf-8')
  child.stderr.on('data', (chunk: string) => {
    stderrTail = (stderrTail + chunk).slice(-2000)
  })

  const done = new Promise<void>((resolve) => {
    child.on('close', (code) => {
      if (!sawResult) {
        options.onEvent({
          type: 'result',
          ok: code === 0,
          error: code === 0 ? undefined : (stderrTail.trim().slice(-400) || `claude 退出码 ${code}`)
        })
      }
      resolve()
    })
    child.on('error', (error) => {
      options.onEvent({ type: 'result', ok: false, error: error.message })
      resolve()
    })
  })

  return {
    cancel: () => { try { child.kill('SIGTERM') } catch { /* already gone */ } },
    shutdown: async () => { await terminateChildProcess(child, { graceMs: 500, killWaitMs: 250 }) },
    done
  }
}
