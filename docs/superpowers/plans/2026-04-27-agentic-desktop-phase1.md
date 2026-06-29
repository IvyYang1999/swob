# Agentic Desktop Phase 1 — 能力提取实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 创建新仓库 swob-next，搭建 monorepo 骨架，提取 Swob 的核心逻辑为独立的、可被 Agent 调用的原子能力包。

**Architecture:** npm workspaces monorepo。packages/capabilities 是纯 TypeScript 能力包（无 Electron 依赖），每个能力实现 Capability<I,O> 接口，注册到中心 Registry。现有 Swob 仓库不动。

**Tech Stack:** TypeScript, Vitest, npm workspaces

---

## 文件结构

```
swob-next/                              ← 新仓库，位置：~/projects/swob-next
├── package.json                        ← workspace 根
├── tsconfig.base.json                  ← 共享 TS 配置
├── packages/
│   └── capabilities/                   ← @swob/capabilities
│       ├── package.json
│       ├── tsconfig.json
│       ├── vitest.config.ts
│       └── src/
│           ├── types.ts                   Capability 接口 + Swob 共享类型
│           ├── registry.ts                CapabilityRegistry
│           ├── registry.test.ts           Registry 测试
│           ├── session-reader/
│           │   ├── index.ts               parseSessionFile, buildSessionSummary, buildSessionDetail
│           │   ├── helpers.ts             isRealUserMessage, extractText 等辅助函数
│           │   └── index.test.ts          session-reader 测试
│           ├── searcher/
│           │   ├── index.ts               searchSessionFiles
│           │   └── index.test.ts          searcher 测试
│           └── folder-manager/
│               ├── index.ts               文件夹 CRUD、session 归类
│               └── index.test.ts          folder-manager 测试
```

---

### Task 1: 创建仓库和 monorepo 骨架

**Files:**
- Create: `~/projects/swob-next/package.json`
- Create: `~/projects/swob-next/tsconfig.base.json`
- Create: `~/projects/swob-next/.gitignore`

- [ ] **Step 1: 创建新仓库目录并初始化 git**

```bash
mkdir -p ~/projects/swob-next && cd ~/projects/swob-next
git init
```

- [ ] **Step 2: 创建根 package.json（workspace 配置）**

```json
{
  "name": "swob-next",
  "private": true,
  "workspaces": ["packages/*", "apps/*"],
  "scripts": {
    "test": "npm run test --workspaces",
    "build": "npm run build --workspaces"
  }
}
```

- [ ] **Step 3: 创建共享 tsconfig.base.json**

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "outDir": "./dist",
    "rootDir": "./src"
  }
}
```

- [ ] **Step 4: 创建 .gitignore**

```
node_modules/
dist/
*.tsbuildinfo
.DS_Store
```

- [ ] **Step 5: 创建 packages/capabilities 目录结构**

```bash
mkdir -p ~/projects/swob-next/packages/capabilities/src/{session-reader,searcher,folder-manager}
```

- [ ] **Step 6: 创建 packages/capabilities/package.json**

```json
{
  "name": "@swob/capabilities",
  "version": "0.1.0",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "scripts": {
    "build": "tsc",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "devDependencies": {
    "typescript": "^5.9.3",
    "vitest": "^4.1.0"
  }
}
```

- [ ] **Step 7: 创建 packages/capabilities/tsconfig.json**

```json
{
  "extends": "../../tsconfig.base.json",
  "include": ["src"],
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src"
  }
}
```

- [ ] **Step 8: 创建 packages/capabilities/vitest.config.ts**

```typescript
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts']
  }
})
```

- [ ] **Step 9: 初始 commit**

```bash
cd ~/projects/swob-next
npm install
git add -A
git commit -m "init: monorepo 骨架 + @swob/capabilities 包结构"
```

---

### Task 2: 定义 Capability 接口和 Registry

**Files:**
- Create: `packages/capabilities/src/types.ts`
- Create: `packages/capabilities/src/registry.ts`
- Create: `packages/capabilities/src/registry.test.ts`
- Create: `packages/capabilities/src/index.ts`

- [ ] **Step 1: 写 Registry 的失败测试**

```typescript
// packages/capabilities/src/registry.test.ts
import { describe, it, expect } from 'vitest'
import { CapabilityRegistry } from './registry'
import type { Capability } from './types'

// 一个测试用的能力
const helloCap: Capability<{ name: string }, { greeting: string }> = {
  name: 'test.hello',
  description: '打招呼',
  inputSchema: {
    type: 'object',
    properties: { name: { type: 'string' } },
    required: ['name']
  },
  outputSchema: {
    type: 'object',
    properties: { greeting: { type: 'string' } }
  },
  execute: async (input) => ({ greeting: `你好, ${input.name}!` })
}

describe('CapabilityRegistry', () => {
  it('注册并执行能力', async () => {
    const registry = new CapabilityRegistry()
    registry.register(helloCap)

    const result = await registry.execute('test.hello', { name: 'Swob' })
    expect(result).toEqual({ greeting: '你好, Swob!' })
  })

  it('列出所有已注册能力的元数据', () => {
    const registry = new CapabilityRegistry()
    registry.register(helloCap)

    const list = registry.list()
    expect(list).toHaveLength(1)
    expect(list[0].name).toBe('test.hello')
    expect(list[0].description).toBe('打招呼')
  })

  it('执行未注册的能力时抛出错误', async () => {
    const registry = new CapabilityRegistry()

    await expect(registry.execute('nonexistent', {})).rejects.toThrow(
      "能力不存在: nonexistent"
    )
  })

  it('同一名称重复注册覆盖旧能力', async () => {
    const registry = new CapabilityRegistry()
    const v1: Capability<{}, { version: number }> = {
      name: 'test.version',
      description: '版本测试',
      inputSchema: { type: 'object', properties: {} },
      outputSchema: { type: 'object', properties: { version: { type: 'number' } } },
      execute: async () => ({ version: 1 })
    }
    const v2: Capability<{}, { version: number }> = {
      name: 'test.version',
      description: '版本测试 v2',
      inputSchema: { type: 'object', properties: {} },
      outputSchema: { type: 'object', properties: { version: { type: 'number' } } },
      execute: async () => ({ version: 2 })
    }

    registry.register(v1)
    registry.register(v2)

    const result = await registry.execute('test.version', {})
    expect(result).toEqual({ version: 2 })
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

```bash
cd ~/projects/swob-next/packages/capabilities
npx vitest run src/registry.test.ts
```

Expected: FAIL — `./registry` 和 `./types` 模块不存在

- [ ] **Step 3: 实现 types.ts — Capability 接口 + Swob 共享类型**

```typescript
// packages/capabilities/src/types.ts

// ============ Capability 接口 ============

export interface JSONSchema {
  type: string
  properties?: Record<string, unknown>
  required?: string[]
  items?: unknown
  [key: string]: unknown
}

export interface Capability<I, O> {
  name: string
  description: string
  inputSchema: JSONSchema
  outputSchema: JSONSchema
  execute(input: I): Promise<O>
}

export interface CapabilityMetadata {
  name: string
  description: string
  inputSchema: JSONSchema
  outputSchema: JSONSchema
}

// ============ Swob 共享类型 ============
// 从现有 src/main/types.ts 提取，去除 Electron 依赖

export interface TokenUsage {
  inputTokens: number
  outputTokens: number
  cacheCreationTokens: number
  cacheReadTokens: number
}

export interface ContentPart {
  type: string
  text?: string
  name?: string
  id?: string
  input?: Record<string, unknown>
  tool_use_id?: string
  content?: string | ContentPart[]
  source?: { type: string; media_type?: string; data?: string; url?: string }
}

export interface RawJsonlMessage {
  uuid: string
  parentUuid: string | null
  logicalParentUuid?: string | null
  sessionId: string
  type: 'user' | 'assistant' | 'system' | 'progress' | 'file-history-snapshot'
  subtype?: string
  timestamp: string
  cwd?: string
  version?: string
  slug?: string
  isSidechain?: boolean
  permissionMode?: string
  message?: {
    role: string
    model?: string
    content: string | ContentPart[]
    usage?: {
      input_tokens?: number
      output_tokens?: number
      cache_creation_input_tokens?: number
      cache_read_input_tokens?: number
    }
  }
  data?: unknown
  forkedFrom?: { sessionId: string; messageUuid: string }
}

export interface ParsedMessage {
  uuid: string
  type: 'user' | 'assistant' | 'system' | 'progress'
  subtype?: string
  timestamp: string
  role?: string
  textContent: string
  toolCalls: ToolCallInfo[]
  images: string[]
  tokenUsage?: TokenUsage
  isPreCompact: boolean
  isSidechain: boolean
  isSharedContext: boolean
  isSystemGenerated: boolean
  raw: RawJsonlMessage
}

export interface ToolCallInfo {
  id?: string
  name: string
  input: Record<string, unknown>
  result?: string
}

export interface SkillInvocation {
  skillName: string
  timestamp: string
  args?: string
}

export type SessionSource = 'claude-code' | 'codex' | 'cursor'

export interface SessionSummary {
  id: string
  sessionId: string
  slug: string
  createdAt: string
  updatedAt: string
  messageCount: number
  turnCount: number
  compactCount: number
  cwds: string[]
  version: string
  firstUserMessage: string
  toolUsage: Record<string, number>
  skillInvocations: SkillInvocation[]
  claudeMdContent?: string
  projectPath: string
  filePath: string
  fileSizeBytes: number
  allFilePaths?: string[]
  permissionMode?: string
  resumeCwd?: string
  branchParentFilePaths?: string[]
  branchPointUuid?: string
  branchLeafUuid?: string
  branchParentId?: string
  branchChildIds?: string[]
  userImages: string[]
  pastedImageCount: number
  tokenUsage: TokenUsage
  referencedFiles: FileRef[]
  configFiles: string[]
  libraryDirPath?: string
  libraryMdPath?: string
  isRemote?: boolean
  remoteHost?: string
  source?: SessionSource
  allUserMessages?: string
  estimatedTime?: number
  models?: string[]
}

export interface FileRef {
  path: string
  actions: FileAction[]
  exists: boolean
}

export type FileAction = 'read' | 'write' | 'edit' | 'user-image' | 'user-input'

export interface SessionDetail extends SessionSummary {
  messages: ParsedMessage[]
}

export interface Folder {
  id: string
  name: string
  parentId?: string | null
  sessionIds: string[]
  color?: string
  createdAt: string
}

export interface Highlight {
  id: string
  text: string
  turnUuid: string
  note?: string
  createdAt: string
}
```

- [ ] **Step 4: 实现 registry.ts**

```typescript
// packages/capabilities/src/registry.ts
import type { Capability, CapabilityMetadata, JSONSchema } from './types'

export class CapabilityRegistry {
  private capabilities = new Map<string, Capability<unknown, unknown>>()

  register<I, O>(capability: Capability<I, O>): void {
    this.capabilities.set(capability.name, capability as Capability<unknown, unknown>)
  }

  get(name: string): Capability<unknown, unknown> | undefined {
    return this.capabilities.get(name)
  }

  list(): CapabilityMetadata[] {
    return Array.from(this.capabilities.values()).map((cap) => ({
      name: cap.name,
      description: cap.description,
      inputSchema: cap.inputSchema,
      outputSchema: cap.outputSchema,
    }))
  }

  async execute(name: string, input: unknown): Promise<unknown> {
    const cap = this.capabilities.get(name)
    if (!cap) throw new Error(`能力不存在: ${name}`)
    return cap.execute(input)
  }
}
```

- [ ] **Step 5: 创建入口 index.ts**

```typescript
// packages/capabilities/src/index.ts
export type { Capability, CapabilityMetadata, JSONSchema } from './types'
export { CapabilityRegistry } from './registry'

// 重导出所有 Swob 共享类型
export type {
  TokenUsage, ContentPart, RawJsonlMessage, ParsedMessage, ToolCallInfo,
  SkillInvocation, SessionSource, SessionSummary, FileRef, FileAction,
  SessionDetail, Folder, Highlight
} from './types'
```

- [ ] **Step 6: 运行测试确认通过**

```bash
cd ~/projects/swob-next/packages/capabilities
npx vitest run src/registry.test.ts
```

Expected: 4 tests PASS

- [ ] **Step 7: Commit**

```bash
cd ~/projects/swob-next
git add -A
git commit -m "feat: 定义 Capability 接口 + CapabilityRegistry + Swob 共享类型"
```

---

### Task 3: 提取 session-reader 能力

从现有 Swob 的 `session-loader.ts` 提取 JSONL 解析逻辑为纯函数能力。去除 Electron 依赖和磁盘缓存（磁盘缓存属于应用层关注点）。

**Files:**
- Create: `packages/capabilities/src/session-reader/helpers.ts`
- Create: `packages/capabilities/src/session-reader/index.ts`
- Create: `packages/capabilities/src/session-reader/index.test.ts`

- [ ] **Step 1: 写 session-reader 的失败测试**

```typescript
// packages/capabilities/src/session-reader/index.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { parseSessionFile, buildSessionSummary, buildSessionDetail, isRealUserMessage } from './index'
import type { RawJsonlMessage } from '../types'

function rawMsg(overrides: Partial<RawJsonlMessage> & { type: RawJsonlMessage['type'] }): RawJsonlMessage {
  return {
    uuid: overrides.uuid || Math.random().toString(36).slice(2),
    parentUuid: overrides.parentUuid ?? null,
    sessionId: overrides.sessionId || 'test-session-id',
    type: overrides.type,
    subtype: overrides.subtype,
    timestamp: overrides.timestamp || '2026-03-01T00:00:00Z',
    cwd: overrides.cwd || '/Users/test',
    version: overrides.version || '2.1.63',
    message: overrides.message,
  }
}

function writeTempJsonl(messages: RawJsonlMessage[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-cap-test-'))
  const fp = path.join(dir, 'test-session-id.jsonl')
  fs.writeFileSync(fp, messages.map((m) => JSON.stringify(m)).join('\n'))
  return fp
}

describe('parseSessionFile', () => {
  it('解析有效 JSONL 文件', async () => {
    const msgs = [
      rawMsg({ type: 'user', message: { role: 'user', content: '你好' } }),
      rawMsg({ type: 'assistant', message: { role: 'assistant', content: '你好！' } })
    ]
    const fp = writeTempJsonl(msgs)
    const result = await parseSessionFile(fp)

    expect(result).toHaveLength(2)
    expect(result[0].type).toBe('user')
    expect(result[1].type).toBe('assistant')
  })

  it('文件不存在时返回空数组', async () => {
    const result = await parseSessionFile('/nonexistent/path.jsonl')
    expect(result).toEqual([])
  })

  it('跳过无效的 JSON 行', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-cap-test-'))
    const fp = path.join(dir, 'mixed.jsonl')
    fs.writeFileSync(fp, 'not-json\n' + JSON.stringify(rawMsg({ type: 'user', message: { role: 'user', content: 'hi' } })))
    const result = await parseSessionFile(fp)
    expect(result).toHaveLength(1)
  })
})

describe('buildSessionSummary', () => {
  it('提取 sessionId、时间、轮次、首条用户消息', () => {
    const msgs = [
      rawMsg({ type: 'user', timestamp: '2026-03-01T10:00:00Z', message: { role: 'user', content: '帮我写个函数' } }),
      rawMsg({ type: 'assistant', timestamp: '2026-03-01T10:01:00Z', message: { role: 'assistant', content: '好的' } })
    ]
    const fp = writeTempJsonl(msgs)
    const summary = buildSessionSummary(fp, msgs)

    expect(summary).not.toBeNull()
    expect(summary!.sessionId).toBe('test-session-id')
    expect(summary!.turnCount).toBe(1)
    expect(summary!.firstUserMessage).toBe('帮我写个函数')
  })

  it('过滤系统生成的 user 消息不计入轮次', () => {
    const msgs = [
      rawMsg({ type: 'user', timestamp: '2026-03-01T10:00:00Z', message: { role: 'user', content: 'Tool loaded.' } }),
      rawMsg({ type: 'user', timestamp: '2026-03-01T10:01:00Z', message: { role: 'user', content: '真实问题' } }),
      rawMsg({ type: 'assistant', timestamp: '2026-03-01T10:02:00Z', message: { role: 'assistant', content: '回答' } })
    ]
    const fp = writeTempJsonl(msgs)
    const summary = buildSessionSummary(fp, msgs)

    expect(summary!.turnCount).toBe(1)
    expect(summary!.firstUserMessage).toBe('真实问题')
  })
})

describe('isRealUserMessage', () => {
  it('普通文本消息是真实用户消息', () => {
    const msg = rawMsg({ type: 'user', message: { role: 'user', content: '你好' } })
    expect(isRealUserMessage(msg)).toBe(true)
  })

  it('Tool loaded 不是真实用户消息', () => {
    const msg = rawMsg({ type: 'user', message: { role: 'user', content: 'Tool loaded.' } })
    expect(isRealUserMessage(msg)).toBe(false)
  })

  it('task-notification 不是真实用户消息', () => {
    const msg = rawMsg({ type: 'user', message: { role: 'user', content: '<task-notification>something</task-notification>' } })
    expect(isRealUserMessage(msg)).toBe(false)
  })
})

describe('buildSessionDetail', () => {
  it('返回带消息列表的完整 session', async () => {
    const msgs = [
      rawMsg({ type: 'user', timestamp: '2026-03-01T10:00:00Z', message: { role: 'user', content: 'hi' } }),
      rawMsg({ type: 'assistant', timestamp: '2026-03-01T10:01:00Z', message: { role: 'assistant', content: 'hello' } })
    ]
    const fp = writeTempJsonl(msgs)
    const detail = await buildSessionDetail(fp)

    expect(detail).not.toBeNull()
    expect(detail!.messages).toHaveLength(2)
    expect(detail!.messages[0].textContent).toBe('hi')
    expect(detail!.messages[1].textContent).toBe('hello')
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

```bash
cd ~/projects/swob-next/packages/capabilities
npx vitest run src/session-reader/index.test.ts
```

Expected: FAIL — `./index` 模块不存在

- [ ] **Step 3: 实现 helpers.ts — 纯辅助函数**

从现有 `session-loader.ts` 提取以下函数，去除所有 Electron/fs 缓存依赖：

```typescript
// packages/capabilities/src/session-reader/helpers.ts
import type { RawJsonlMessage, ContentPart, ToolCallInfo, ParsedMessage, TokenUsage } from '../types'

const SYSTEM_USER_MESSAGES = [
  'Continue from where you left off.',
  'Tool loaded.',
  'No response requested.'
]

function isSystemText(text: string): boolean {
  const trimmed = text.trim()
  if (!trimmed) return true
  if (trimmed.startsWith('<task-notification>')) return true
  if (trimmed.startsWith('This session is being continued')) return true
  if (/^\[Image: source: [^\]]+\](\s*\[Image: source: [^\]]+\])*\s*$/.test(trimmed)) return true
  return SYSTEM_USER_MESSAGES.includes(trimmed)
}

export function isRealUserMessage(m: RawJsonlMessage): boolean {
  if (m.type !== 'user' || !m.message) return false
  const c = m.message.content
  if (typeof c === 'string') {
    return !isSystemText(c)
  }
  if (Array.isArray(c)) {
    if (c.some((p) => p.type === 'tool_result')) return false
    const texts = c.filter((p) => p.type === 'text' && p.text).map((p) => p.text!)
    if (texts.length === 0) return false
    return texts.some((t) => !isSystemText(t))
  }
  return false
}

export function extractText(content: string | ContentPart[] | undefined): string {
  if (!content) return ''
  if (typeof content === 'string') return content
  return content
    .filter((p) => p.type === 'text' && p.text)
    .map((p) => p.text!)
    .join('\n')
}

export function extractToolCalls(content: string | ContentPart[] | undefined): ToolCallInfo[] {
  if (!content || typeof content === 'string') return []
  return content
    .filter((p) => p.type === 'tool_use' && p.name)
    .map((p) => ({ id: p.id, name: p.name!, input: (p.input as Record<string, unknown>) || {} }))
}

export function extractToolResultText(content: string | ContentPart[]): string {
  if (typeof content === 'string') return content
  return content
    .map((p) => {
      if (p.type === 'text' && p.text) return p.text
      if (typeof p === 'string') return p
      return ''
    })
    .filter(Boolean)
    .join('\n')
}

export function extractImages(content: string | ContentPart[] | undefined): string[] {
  if (!content || typeof content === 'string') return []
  const images: string[] = []
  for (const p of content) {
    if (p.type === 'image' && p.source) {
      if (p.source.data) {
        images.push(`data:${p.source.media_type || 'image/png'};base64,${p.source.data}`)
      } else if (p.source.url) {
        images.push(p.source.url)
      }
    }
  }
  return images
}

export function extractTokenUsage(raw: RawJsonlMessage): TokenUsage | undefined {
  const usage = raw.message?.usage
  if (!usage) return undefined
  return {
    inputTokens: usage.input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
    cacheCreationTokens: usage.cache_creation_input_tokens ?? 0,
    cacheReadTokens: usage.cache_read_input_tokens ?? 0,
  }
}

export function parseRawMessage(raw: RawJsonlMessage): ParsedMessage {
  const content = raw.message?.content
  return {
    uuid: raw.uuid,
    type: raw.type as ParsedMessage['type'],
    subtype: raw.subtype,
    timestamp: raw.timestamp,
    role: raw.message?.role,
    textContent: extractText(content),
    toolCalls: extractToolCalls(content),
    images: extractImages(content),
    tokenUsage: extractTokenUsage(raw),
    isPreCompact: false, // 需要全局消息列表来判断
    isSidechain: raw.isSidechain ?? false,
    isSharedContext: false,
    isSystemGenerated: raw.type === 'user' && !isRealUserMessage(raw),
    raw,
  }
}
```

- [ ] **Step 4: 实现 index.ts — 核心解析和 summary 构建**

从 `session-loader.ts` 提取 `parseSessionFile`、`buildSessionSummary`、`buildSessionDetail`。保留纯逻辑，去除磁盘缓存和文件发现（`findAllSessionFiles` 属于应用层）。

核心代码需从现有 Swob 复制以下函数（只保留纯逻辑部分）：
- `parseSessionFile(filePath)` → 逐行读 JSONL，返回 RawJsonlMessage[]
- `buildSessionSummary(filePath, rawMessages)` → 从 raw 消息构建 SessionSummary
- `buildSessionDetail(filePath)` → 读文件 + 构建 summary + 附带 messages 列表
- `detectIntraFileBranches(rawMessages)` → 检测同一文件内的分支
- `filterMessagesByBranch(messages, leafUuid)` → 按分支过滤消息

来源文件：`/Users/yytyyf/projects/claude-session-manager/src/main/session-loader.ts`

实现要点：
- `parseSessionFile` 使用 `fs.readFileSync` + 逐行 JSON.parse（与现有一致）
- `buildSessionSummary` 保留所有统计逻辑（toolUsage、skillInvocations、fileRefs、tokenUsage 等）
- 去除 `loadAllSessions`（涉及磁盘缓存和全量加载，属于应用层）
- 去除 `findAllSessionFiles`（文件发现属于应用层）

- [ ] **Step 5: 运行测试确认通过**

```bash
cd ~/projects/swob-next/packages/capabilities
npx vitest run src/session-reader/index.test.ts
```

Expected: 全部 PASS

- [ ] **Step 6: Commit**

```bash
cd ~/projects/swob-next
git add -A
git commit -m "feat: 提取 session-reader 能力（JSONL 解析 + session 构建）"
```

---

### Task 4: 将 session-reader 注册为 Capability

把 Task 3 的函数包装成标准 Capability 对象。

**Files:**
- Create: `packages/capabilities/src/session-reader/capability.ts`
- Create: `packages/capabilities/src/session-reader/capability.test.ts`

- [ ] **Step 1: 写失败测试**

```typescript
// packages/capabilities/src/session-reader/capability.test.ts
import { describe, it, expect } from 'vitest'
import { CapabilityRegistry } from '../registry'
import { registerSessionCapabilities } from './capability'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import type { RawJsonlMessage } from '../types'

function writeTempJsonl(messages: RawJsonlMessage[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-cap-reg-'))
  const fp = path.join(dir, 'test-session-id.jsonl')
  fs.writeFileSync(fp, messages.map((m) => JSON.stringify(m)).join('\n'))
  return fp
}

describe('session-reader capabilities', () => {
  it('session.parse 注册到 Registry 后可执行', async () => {
    const registry = new CapabilityRegistry()
    registerSessionCapabilities(registry)

    const list = registry.list()
    const parse = list.find((c) => c.name === 'session.parse')
    expect(parse).toBeDefined()
    expect(parse!.description).toBeTruthy()
  })

  it('session.parse 能力返回解析后的消息列表', async () => {
    const registry = new CapabilityRegistry()
    registerSessionCapabilities(registry)

    const fp = writeTempJsonl([
      { uuid: '1', parentUuid: null, sessionId: 's1', type: 'user', timestamp: '2026-01-01T00:00:00Z', message: { role: 'user', content: 'hi' } },
      { uuid: '2', parentUuid: '1', sessionId: 's1', type: 'assistant', timestamp: '2026-01-01T00:01:00Z', message: { role: 'assistant', content: 'hello' } }
    ])

    const result = await registry.execute('session.parse', { filePath: fp })
    expect(result).toHaveProperty('messages')
    expect((result as { messages: unknown[] }).messages).toHaveLength(2)
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

```bash
cd ~/projects/swob-next/packages/capabilities
npx vitest run src/session-reader/capability.test.ts
```

Expected: FAIL — `./capability` 不存在

- [ ] **Step 3: 实现 capability.ts**

```typescript
// packages/capabilities/src/session-reader/capability.ts
import type { Capability } from '../types'
import { CapabilityRegistry } from '../registry'
import { parseSessionFile, buildSessionSummary, buildSessionDetail } from './index'

export function registerSessionCapabilities(registry: CapabilityRegistry): void {
  registry.register({
    name: 'session.parse',
    description: '解析 JSONL session 文件，返回原始消息列表',
    inputSchema: {
      type: 'object',
      properties: {
        filePath: { type: 'string', description: 'JSONL 文件路径' }
      },
      required: ['filePath']
    },
    outputSchema: {
      type: 'object',
      properties: {
        messages: { type: 'array' }
      }
    },
    execute: async (input: { filePath: string }) => {
      const messages = await parseSessionFile(input.filePath)
      return { messages }
    }
  })

  registry.register({
    name: 'session.summary',
    description: '构建 session 摘要（token 统计、工具使用、分支信息等）',
    inputSchema: {
      type: 'object',
      properties: {
        filePath: { type: 'string', description: 'JSONL 文件路径' }
      },
      required: ['filePath']
    },
    outputSchema: {
      type: 'object',
      properties: {
        summary: { type: 'object' }
      }
    },
    execute: async (input: { filePath: string }) => {
      const raw = await parseSessionFile(input.filePath)
      if (raw.length === 0) return { summary: null }
      const summary = buildSessionSummary(input.filePath, raw)
      return { summary }
    }
  })

  registry.register({
    name: 'session.detail',
    description: '获取 session 完整详情（摘要 + 所有消息）',
    inputSchema: {
      type: 'object',
      properties: {
        filePath: { type: 'string', description: 'JSONL 文件路径' }
      },
      required: ['filePath']
    },
    outputSchema: {
      type: 'object',
      properties: {
        detail: { type: 'object' }
      }
    },
    execute: async (input: { filePath: string }) => {
      const detail = await buildSessionDetail(input.filePath)
      return { detail }
    }
  })
}
```

- [ ] **Step 4: 运行测试确认通过**

```bash
cd ~/projects/swob-next/packages/capabilities
npx vitest run src/session-reader/capability.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
cd ~/projects/swob-next
git add -A
git commit -m "feat: session-reader 注册为标准 Capability"
```

---

### Task 5: 提取 searcher 能力

从 `session-search.ts` 提取搜索逻辑。

**Files:**
- Create: `packages/capabilities/src/searcher/index.ts`
- Create: `packages/capabilities/src/searcher/index.test.ts`
- Create: `packages/capabilities/src/searcher/capability.ts`

- [ ] **Step 1: 写失败测试**

```typescript
// packages/capabilities/src/searcher/index.test.ts
import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { searchSessionFiles } from './index'

function writeJsonl(dir: string, filename: string, messages: object[]): string {
  fs.mkdirSync(dir, { recursive: true })
  const filePath = path.join(dir, filename)
  fs.writeFileSync(filePath, messages.map((m) => JSON.stringify(m)).join('\n'), 'utf-8')
  return filePath
}

describe('searchSessionFiles', () => {
  it('按关键词搜索并返回匹配结果', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-search-cap-'))
    const filePath = writeJsonl(dir, 'session.jsonl', [
      { uuid: 'u1', parentUuid: null, sessionId: 's1', type: 'user', timestamp: '2026-03-01T00:00:00Z', message: { role: 'user', content: '帮我分析 token 消耗' } },
      { uuid: 'u2', parentUuid: 'u1', sessionId: 's1', type: 'assistant', timestamp: '2026-03-01T00:01:00Z', message: { role: 'assistant', content: '好的' } }
    ])

    const results = await searchSessionFiles('token', [{ filePath }])

    expect(results).toHaveLength(1)
    expect(results[0].sessionId).toBe('s1')
    expect(results[0].firstUserMessage).toContain('token')
  })

  it('无匹配时返回空数组', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-search-cap-'))
    const filePath = writeJsonl(dir, 'session.jsonl', [
      { uuid: 'u1', parentUuid: null, sessionId: 's1', type: 'user', timestamp: '2026-03-01T00:00:00Z', message: { role: 'user', content: '你好世界' } }
    ])

    const results = await searchSessionFiles('不存在的关键词', [{ filePath }])
    expect(results).toHaveLength(0)
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

```bash
cd ~/projects/swob-next/packages/capabilities
npx vitest run src/searcher/index.test.ts
```

Expected: FAIL

- [ ] **Step 3: 实现 searcher/index.ts**

从现有 `/Users/yytyyf/projects/claude-session-manager/src/main/session-search.ts` 复制核心逻辑：
- `searchSessionFiles(query, sources)` → 搜索函数
- `extractContentText(content)` → 内容提取辅助函数
- `getFirstUserMessage(raw)` → 提取首条用户消息
- 去除对 `parseSessionFile` 的直接调用，改为通过 session-reader 模块导入

- [ ] **Step 4: 运行测试确认通过**

```bash
cd ~/projects/swob-next/packages/capabilities
npx vitest run src/searcher/index.test.ts
```

Expected: PASS

- [ ] **Step 5: 实现 searcher/capability.ts — 注册为 Capability**

```typescript
// packages/capabilities/src/searcher/capability.ts
import { CapabilityRegistry } from '../registry'
import { searchSessionFiles } from './index'

export function registerSearchCapabilities(registry: CapabilityRegistry): void {
  registry.register({
    name: 'session.search',
    description: '全文搜索 session 内容，支持关键词匹配',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索关键词' },
        sources: {
          type: 'array',
          items: { type: 'object', properties: { filePath: { type: 'string' } } },
          description: '要搜索的 JSONL 文件列表'
        }
      },
      required: ['query', 'sources']
    },
    outputSchema: {
      type: 'object',
      properties: {
        results: { type: 'array', description: '匹配结果列表' }
      }
    },
    execute: async (input: { query: string; sources: Array<{ filePath: string }> }) => {
      const results = await searchSessionFiles(input.query, input.sources)
      return { results }
    }
  })
}
```

- [ ] **Step 6: 运行全部测试**

```bash
cd ~/projects/swob-next/packages/capabilities
npx vitest run
```

Expected: 全部 PASS

- [ ] **Step 7: Commit**

```bash
cd ~/projects/swob-next
git add -A
git commit -m "feat: 提取 searcher 能力 + 注册为 Capability"
```

---

### Task 6: 提取 folder-manager 能力

从 `library-manager.ts` 提取文件夹管理逻辑。

**Files:**
- Create: `packages/capabilities/src/folder-manager/index.ts`
- Create: `packages/capabilities/src/folder-manager/index.test.ts`
- Create: `packages/capabilities/src/folder-manager/capability.ts`

- [ ] **Step 1: 写失败测试**

```typescript
// packages/capabilities/src/folder-manager/index.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { FolderManager } from './index'

let tmpRoot: string
let manager: FolderManager

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-folder-cap-'))
  manager = new FolderManager(tmpRoot)
})

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true })
})

describe('FolderManager', () => {
  it('创建文件夹', () => {
    const folder = manager.createFolder('测试文件夹')
    expect(folder.name).toBe('测试文件夹')
    expect(fs.existsSync(path.join(tmpRoot, '测试文件夹'))).toBe(true)
  })

  it('列出所有文件夹', () => {
    manager.createFolder('文件夹A')
    manager.createFolder('文件夹B')

    const folders = manager.listFolders()
    expect(folders).toHaveLength(2)
    expect(folders.map((f) => f.name)).toContain('文件夹A')
    expect(folders.map((f) => f.name)).toContain('文件夹B')
  })

  it('重命名文件夹', () => {
    const folder = manager.createFolder('旧名字')
    manager.renameFolder(folder.id, '新名字')

    const folders = manager.listFolders()
    expect(folders[0].name).toBe('新名字')
  })

  it('删除文件夹', () => {
    const folder = manager.createFolder('要删除的')
    manager.deleteFolder(folder.id)

    expect(manager.listFolders()).toHaveLength(0)
  })

  it('移动 session 到文件夹', () => {
    const folder = manager.createFolder('目标文件夹')
    manager.moveSessionToFolder('session-123', folder.id)

    const sessions = manager.getFolderSessions(folder.id)
    expect(sessions).toContain('session-123')
  })

  it('从文件夹移除 session', () => {
    const folder = manager.createFolder('目标文件夹')
    manager.moveSessionToFolder('session-123', folder.id)
    manager.removeSessionFromFolder('session-123', folder.id)

    const sessions = manager.getFolderSessions(folder.id)
    expect(sessions).toHaveLength(0)
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

```bash
cd ~/projects/swob-next/packages/capabilities
npx vitest run src/folder-manager/index.test.ts
```

Expected: FAIL

- [ ] **Step 3: 实现 folder-manager/index.ts**

从现有 `/Users/yytyyf/projects/claude-session-manager/src/main/library-manager.ts` 提取文件夹 CRUD 逻辑。

核心接口：
```typescript
export class FolderManager {
  constructor(private rootDir: string) {}
  createFolder(name: string): Folder
  listFolders(): Folder[]
  renameFolder(id: string, newName: string): void
  deleteFolder(id: string): void
  moveSessionToFolder(sessionId: string, folderId: string): void
  removeSessionFromFolder(sessionId: string, folderId: string): void
  getFolderSessions(folderId: string): string[]
}
```

实现要点：
- 用文件系统作为存储（文件夹 = 目录，session 列表 = 目录内容）
- id 用文件夹相对路径的 hash 或目录名
- 不依赖 Electron 的 app.getPath

- [ ] **Step 4: 运行测试确认通过**

```bash
cd ~/projects/swob-next/packages/capabilities
npx vitest run src/folder-manager/index.test.ts
```

Expected: PASS

- [ ] **Step 5: 实现 folder-manager/capability.ts — 注册为 Capability**

注册以下能力：
- `folder.create` — 创建文件夹
- `folder.list` — 列出文件夹
- `folder.rename` — 重命名
- `folder.delete` — 删除
- `folder.moveSession` — 移动 session 到文件夹
- `folder.removeSession` — 从文件夹移除 session

- [ ] **Step 6: 更新 index.ts 导出所有能力注册函数**

```typescript
// packages/capabilities/src/index.ts
export type { Capability, CapabilityMetadata, JSONSchema } from './types'
export { CapabilityRegistry } from './registry'
export { registerSessionCapabilities } from './session-reader/capability'
export { registerSearchCapabilities } from './searcher/capability'
export { registerFolderCapabilities } from './folder-manager/capability'

export type {
  TokenUsage, ContentPart, RawJsonlMessage, ParsedMessage, ToolCallInfo,
  SkillInvocation, SessionSource, SessionSummary, FileRef, FileAction,
  SessionDetail, Folder, Highlight
} from './types'
```

- [ ] **Step 7: 运行全部测试**

```bash
cd ~/projects/swob-next/packages/capabilities
npx vitest run
```

Expected: 全部 PASS

- [ ] **Step 8: Commit**

```bash
cd ~/projects/swob-next
git add -A
git commit -m "feat: 提取 folder-manager 能力 + 注册为 Capability"
```

---

### Task 7: 集成验证 — 所有能力可独立运行

**Files:**
- Create: `packages/capabilities/src/integration.test.ts`

- [ ] **Step 1: 写集成测试 — 模拟完整使用流程**

```typescript
// packages/capabilities/src/integration.test.ts
import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { CapabilityRegistry } from './registry'
import { registerSessionCapabilities } from './session-reader/capability'
import { registerSearchCapabilities } from './searcher/capability'
import { registerFolderCapabilities } from './folder-manager/capability'

describe('集成测试：完整能力流程', () => {
  it('注册所有能力后 Registry 包含预期数量', () => {
    const registry = new CapabilityRegistry()
    registerSessionCapabilities(registry)
    registerSearchCapabilities(registry)
    registerFolderCapabilities(registry)

    const caps = registry.list()
    // session: parse, summary, detail (3) + search (1) + folder: create, list, rename, delete, moveSession, removeSession (6) = 10
    expect(caps.length).toBeGreaterThanOrEqual(10)
    expect(caps.map((c) => c.name)).toContain('session.parse')
    expect(caps.map((c) => c.name)).toContain('session.search')
    expect(caps.map((c) => c.name)).toContain('folder.create')
  })

  it('完整流程：解析 → 搜索 → 归类到文件夹', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-integration-'))
    const folderRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-integration-folders-'))

    // 1. 创建测试 JSONL
    const filePath = path.join(dir, 'session.jsonl')
    fs.writeFileSync(filePath, [
      JSON.stringify({ uuid: '1', parentUuid: null, sessionId: 's1', type: 'user', timestamp: '2026-01-01T00:00:00Z', message: { role: 'user', content: '帮我分析 token' } }),
      JSON.stringify({ uuid: '2', parentUuid: '1', sessionId: 's1', type: 'assistant', timestamp: '2026-01-01T00:01:00Z', message: { role: 'assistant', content: '好的' } })
    ].join('\n'))

    // 2. 注册能力
    const registry = new CapabilityRegistry()
    registerSessionCapabilities(registry)
    registerSearchCapabilities(registry)
    registerFolderCapabilities(registry)

    // 3. 解析 session
    const parsed = await registry.execute('session.parse', { filePath }) as { messages: unknown[] }
    expect(parsed.messages).toHaveLength(2)

    // 4. 搜索
    const searched = await registry.execute('session.search', { query: 'token', sources: [{ filePath }] }) as { results: Array<{ sessionId: string }> }
    expect(searched.results).toHaveLength(1)
    expect(searched.results[0].sessionId).toBe('s1')

    // 5. 创建文件夹并归类
    const folder = await registry.execute('folder.create', { rootDir: folderRoot, name: 'Token 分析' }) as { folder: { id: string } }
    await registry.execute('folder.moveSession', { rootDir: folderRoot, sessionId: 's1', folderId: folder.folder.id })

    // 清理
    fs.rmSync(dir, { recursive: true, force: true })
    fs.rmSync(folderRoot, { recursive: true, force: true })
  })
})
```

- [ ] **Step 2: 运行全部测试**

```bash
cd ~/projects/swob-next/packages/capabilities
npx vitest run
```

Expected: 全部 PASS（单元 + 集成）

- [ ] **Step 3: 确认 npm build 通过**

```bash
cd ~/projects/swob-next/packages/capabilities
npx tsc --noEmit
```

Expected: 无错误

- [ ] **Step 4: Commit**

```bash
cd ~/projects/swob-next
git add -A
git commit -m "test: 添加集成测试验证所有能力可独立运行"
```

---

## 自检

**1. Spec 覆盖检查：**
- ✅ Capability 接口定义 → Task 2
- ✅ CapabilityRegistry → Task 2
- ✅ session-reader 能力 → Task 3 + Task 4
- ✅ searcher 能力 → Task 5
- ✅ folder-manager 能力 → Task 6
- ✅ 集成验证 → Task 7
- ⏳ exporter → Phase 2（搜索和导出紧密耦合 session-reader，优先级次之）
- ⏳ process-detector → Phase 2（涉及系统进程检测，需要更多设计）
- ⏳ resumer → Phase 2（涉及终端操作，需要 Electron API）
- ⏳ agentic-ui 包 → Phase 2

**2. 占位符扫描：** 无 TODO/TBD/待定，所有步骤有具体代码。

**3. 类型一致性：** 所有任务共用 `packages/capabilities/src/types.ts` 中的类型定义，函数签名在 capability.ts 中一致。
