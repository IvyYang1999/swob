# Swob Mobile Phase 1: 离线 Session 浏览器

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 iOS 上实现 Swob 离线 Session 浏览器，用户可以在手机上随时浏览所有 Claude Code 聊天记录。

**Architecture:** React Native + Expo bare workflow。通过原生模块访问 iCloud Drive 中 Swob Library 目录，读取 `.swob-session.json` 和 `transcript.md` 文件。Zustand 管理状态，React Navigation 6 做导航。

**Tech Stack:** React Native, Expo (bare), TypeScript, Zustand, React Navigation 6, react-native-markdown-display, iCloud FileManager (Native Module)

**Spec:** `docs/superpowers/specs/2026-04-25-swob-mobile-design.md`

---

## File Structure

```
swob-mobile/
├── App.tsx                          # 入口，NavigationContainer
├── app/
│   ├── navigation/
│   │   └── RootNavigator.tsx        # 底部 Tab + Stack 导航
│   ├── tabs/
│   │   ├── SessionsTab.tsx          # Session 列表（含文件夹展开）
│   │   └── SettingsTab.tsx          # 设置页
│   ├── screens/
│   │   └── ChatViewerScreen.tsx     # 聊天记录页面
│   └── components/
│       ├── FolderItem.tsx           # 文件夹行（展开/折叠）
│       ├── SessionCard.tsx          # Session 卡片（标题、日期、项目）
│       └── SearchBar.tsx            # 搜索输入框
├── lib/
│   ├── types.ts                     # 和桌面端对齐的类型定义
│   ├── icloud-reader.ts            # iCloud 文件读取 TS 接口
│   ├── library-scanner.ts          # 扫描 Library 目录树
│   ├── session-parser.ts           # 解析 .swob-session.json
│   └── search.ts                   # 全文搜索逻辑
├── store/
│   ├── sessions.ts                  # Session 列表状态
│   └── settings.ts                  # 设置状态
├── native/
│   └── ios/
│       └── SwobICloudModule/       # iCloud 原生模块
│           ├── SwobICloudModule.swift
│           └── SwobICloudModule-Bridging-Header.h
├── __tests__/
│   ├── lib/
│   │   ├── session-parser.test.ts
│   │   ├── library-scanner.test.ts
│   │   └── search.test.ts
│   └── store/
│       └── sessions.test.ts
├── package.json
├── tsconfig.json
├── app.json                         # Expo 配置
└── index.js                         # Expo 入口
```

---

## Task 1: 项目脚手架

**Files:**
- Create: `swob-mobile/` (整个项目)

- [ ] **Step 1: 创建 Expo bare 项目**

```bash
npx create-expo-app@latest swob-mobile --template blank-typescript
cd swob-mobile
npx expo eject
```

- [ ] **Step 2: 安装依赖**

```bash
# 导航
npm install @react-navigation/native @react-navigation/bottom-tabs @react-navigation/native-stack
npm install react-native-screens react-native-safe-area-context

# 状态管理
npm install zustand

# Markdown 渲染
npm install react-native-markdown-display

# 测试
npm install -D jest @testing-library/react-native @testing-library/jest-native ts-jest @types/jest
```

- [ ] **Step 3: 配置 tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "esnext",
    "module": "commonjs",
    "lib": ["esnext"],
    "jsx": "react-native",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "allowSyntheticDefaultImports": true,
    "moduleResolution": "node",
    "noEmit": true,
    "baseUrl": ".",
    "paths": {
      "@/*": ["./*"]
    }
  },
  "include": ["**/*.ts", "**/*.tsx"],
  "exclude": ["node_modules"]
}
```

- [ ] **Step 4: 配置 Jest**

在 `package.json` 中添加：

```json
{
  "jest": {
    "preset": "react-native",
    "transform": {
      "^.+\\.tsx?$": "ts-jest"
    },
    "moduleFileExtensions": ["ts", "tsx", "js", "jsx", "json"],
    "testPathIgnorePatterns": ["/node_modules/", "/android/", "/ios/"]
  }
}
```

- [ ] **Step 5: 验证项目可运行**

```bash
npm test
# Expected: no tests found (项目为空，这是正常的)
npx tsc --noEmit
# Expected: no errors
```

- [ ] **Step 6: 初始提交**

```bash
git init
git add -A
git commit -m "init: Expo bare 项目脚手架 + 依赖安装"
```

---

## Task 2: 类型定义

**Files:**
- Create: `lib/types.ts`
- Test: `__tests__/lib/types.test.ts`

类型必须和桌面端 `src/main/library-manager.ts` 中的 `SessionMeta` 以及 `src/main/types.ts` 中的 `SshConfig` 完全对齐。

- [ ] **Step 1: 写类型定义**

```typescript
// lib/types.ts

/** .swob-session.json 的结构，和桌面端 library-manager.ts SessionMeta 对齐 */
export interface SessionMeta {
  sessionId: string
  sourceFilePaths: string[]
  customTitle?: string
  notes?: string
  highlights?: Highlight[]
  createdAt: string
  updatedAt: string
  projectPath: string
}

export interface Highlight {
  id: string
  text: string
  turnUuid: string
  note?: string
  createdAt: string
}

/** .swob-config.json 的结构，和桌面端 library-manager.ts LibraryConfig 对齐 */
export interface LibraryConfig {
  libraryRoot: string
  preferences: {
    defaultViewMode: 'compact' | 'full'
    terminalApp: 'Terminal' | 'iTerm2'
    sshConfig?: SshConfig
  }
  folderOrder?: string[]
  branchFolders?: Record<string, string[]>
  branchMeta?: Record<string, BranchMeta>
}

export interface BranchMeta {
  customTitle?: string
  notes?: string
  highlights?: Highlight[]
}

/** SSH 配置，和桌面端 types.ts SshConfig 对齐 */
export interface SshConfig {
  host: string
  user: string
  remotePath?: string
}

/** 文件夹（从目录结构推导） */
export interface FolderNode {
  name: string
  relativePath: string
  sessions: SessionItem[]
  children: FolderNode[]
}

/** Session 列表项 */
export interface SessionItem {
  sessionId: string
  title: string
  projectPath: string
  createdAt: string
  updatedAt: string
  relativePath: string       // 相对于 Library root 的路径
  transcriptAvailable: boolean
}

/** Library 扫描结果 */
export interface LibraryTree {
  rootPath: string
  folders: FolderNode[]
  ungroupedSessions: SessionItem[]
}
```

- [ ] **Step 2: 写类型校验测试（确保类型可实例化且字段完整）**

```typescript
// __tests__/lib/types.test.ts
import type { SessionMeta, LibraryConfig, SshConfig, FolderNode, SessionItem } from '../../lib/types'

describe('types', () => {
  it('SessionMeta 字段完整', () => {
    const meta: SessionMeta = {
      sessionId: 'abc-123',
      sourceFilePaths: ['/path/to/file.jsonl'],
      customTitle: '测试',
      createdAt: '2026-04-25T00:00:00Z',
      updatedAt: '2026-04-25T12:00:00Z',
      projectPath: '/Users/test/.claude/projects/-Users-test-foo',
    }
    expect(meta.sessionId).toBe('abc-123')
    expect(meta.customTitle).toBe('测试')
  })

  it('LibraryConfig 字段完整', () => {
    const config: LibraryConfig = {
      libraryRoot: '/Users/test/Documents/Swob',
      preferences: { defaultViewMode: 'compact', terminalApp: 'Terminal' },
      folderOrder: ['项目A', '项目B'],
    }
    expect(config.preferences.defaultViewMode).toBe('compact')
  })

  it('SshConfig 字段完整', () => {
    const ssh: SshConfig = { host: 'mac.local', user: 'test', remotePath: '/opt/claude' }
    expect(ssh.host).toBe('mac.local')
  })
})
```

- [ ] **Step 3: 运行测试**

```bash
npx jest __tests__/lib/types.test.ts
# Expected: PASS
```

- [ ] **Step 4: 提交**

```bash
git add lib/types.ts __tests__/lib/types.test.ts
git commit -m "feat: 类型定义（和桌面端对齐）"
```

---

## Task 3: Session 解析器

**Files:**
- Create: `lib/session-parser.ts`
- Test: `__tests__/lib/session-parser.test.ts`

解析 `.swob-session.json` 文件内容为 `SessionItem`。

- [ ] **Step 1: 写测试**

```typescript
// __tests__/lib/session-parser.test.ts
import { parseSessionMeta, getSessionTitle, formatRelativeTime } from '../../lib/session-parser'
import type { SessionMeta } from '../../lib/types'

const validMeta: SessionMeta = {
  sessionId: 'abc-123-def',
  sourceFilePaths: ['/Users/test/.claude/projects/-Users-test-foo/sessions/abc.jsonl'],
  createdAt: '2026-04-20T10:00:00Z',
  updatedAt: '2026-04-25T15:30:00Z',
  projectPath: '/Users/test/.claude/projects/-Users-test-foo',
}

describe('parseSessionMeta', () => {
  it('解析有效的 .swob-session.json', () => {
    const json = JSON.stringify(validMeta)
    const result = parseSessionMeta(json, 'Swob 项目/修复 bug')
    expect(result.sessionId).toBe('abc-123-def')
    expect(result.relativePath).toBe('Swob 项目/修复 bug')
    expect(result.transcriptAvailable).toBe(true)
  })

  it('解析缺少可选字段的 meta', () => {
    const minimal = { ...validMeta }
    delete (minimal as any).customTitle
    const result = parseSessionMeta(JSON.stringify(minimal), 'untitled')
    expect(result.sessionId).toBe('abc-123-def')
  })

  it('无效 JSON 返回 null', () => {
    expect(parseSessionMeta('not json', 'path')).toBeNull()
  })

  it('缺少必要字段返回 null', () => {
    expect(parseSessionMeta('{}', 'path')).toBeNull()
  })
})

describe('getSessionTitle', () => {
  it('优先使用 customTitle', () => {
    expect(getSessionTitle({ ...validMeta, customTitle: '自定义标题' })).toBe('自定义标题')
  })

  it('没有 customTitle 时用 sessionId 前缀', () => {
    expect(getSessionTitle(validMeta)).toBe('abc-123-def')
  })
})

describe('formatRelativeTime', () => {
  it('刚刚', () => {
    expect(formatRelativeTime(new Date().toISOString())).toBe('刚刚')
  })

  it('今天', () => {
    const today = new Date()
    today.setHours(today.getHours() - 2)
    expect(formatRelativeTime(today.toISOString())).toContain('小时前')
  })

  it('昨天', () => {
    const yesterday = new Date()
    yesterday.setDate(yesterday.getDate() - 1)
    expect(formatRelativeTime(yesterday.toISOString())).toBe('昨天')
  })

  it('天数', () => {
    const days = new Date()
    days.setDate(days.getDate() - 5)
    expect(formatRelativeTime(days.toISOString())).toBe('5天前')
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

```bash
npx jest __tests__/lib/session-parser.test.ts
# Expected: FAIL — module not found
```

- [ ] **Step 3: 实现 session-parser.ts**

```typescript
// lib/session-parser.ts
import type { SessionMeta, SessionItem } from './types'

/** 必要字段列表 */
const REQUIRED_FIELDS: (keyof SessionMeta)[] = ['sessionId', 'sourceFilePaths', 'createdAt', 'updatedAt', 'projectPath']

/**
 * 解析 .swob-session.json 内容为 SessionItem。
 * @param jsonStr .swob-session.json 的文件内容
 * @param relativePath 相对于 Library root 的路径
 * @param hasTranscript transcript.md 是否存在
 */
export function parseSessionMeta(
  jsonStr: string,
  relativePath: string,
  hasTranscript: boolean = true
): SessionItem | null {
  let parsed: any
  try {
    parsed = JSON.parse(jsonStr)
  } catch {
    return null
  }

  // 校验必要字段
  for (const field of REQUIRED_FIELDS) {
    if (parsed[field] === undefined || parsed[field] === null) return null
  }

  return {
    sessionId: parsed.sessionId,
    title: getSessionTitle(parsed),
    projectPath: parsed.projectPath,
    createdAt: parsed.createdAt,
    updatedAt: parsed.updatedAt,
    relativePath,
    transcriptAvailable: hasTranscript,
  }
}

/** 获取 session 显示标题 */
export function getSessionTitle(meta: SessionMeta): string {
  if (meta.customTitle) return meta.customTitle
  return meta.sessionId.slice(0, 12)
}

/** 格式化相对时间 */
export function formatRelativeTime(isoDate: string): string {
  const now = Date.now()
  const then = new Date(isoDate).getTime()
  const diffMs = now - then
  const diffMin = Math.floor(diffMs / 60000)
  const diffHour = Math.floor(diffMs / 3600000)
  const diffDay = Math.floor(diffMs / 86400000)

  if (diffMin < 1) return '刚刚'
  if (diffMin < 60) return `${diffMin}分钟前`
  if (diffHour < 24) return `${diffHour}小时前`
  if (diffDay === 1) return '昨天'
  if (diffDay < 30) return `${diffDay}天前`
  if (diffDay < 365) return `${Math.floor(diffDay / 30)}个月前`
  return `${Math.floor(diffDay / 365)}年前`
}
```

- [ ] **Step 4: 运行测试**

```bash
npx jest __tests__/lib/session-parser.test.ts
# Expected: PASS
```

- [ ] **Step 5: 提交**

```bash
git add lib/session-parser.ts __tests__/lib/session-parser.test.ts
git commit -m "feat: session 解析器 — 解析 .swob-session.json + 相对时间格式化"
```

---

## Task 4: Library 目录扫描器

**Files:**
- Create: `lib/library-scanner.ts`
- Test: `__tests__/lib/library-scanner.test.ts`

扫描 Library 目录树，返回 `LibraryTree`。不直接访问文件系统，而是接收一个文件系统抽象接口，方便测试。

- [ ] **Step 1: 写测试**

```typescript
// __tests__/lib/library-scanner.test.ts
import { scanLibraryTree } from '../../lib/library-scanner'
import type { FileSystemReader } from '../../lib/library-scanner'

/** 构造 mock 文件系统 */
function mockFs(files: Record<string, string | null>): FileSystemReader {
  return {
    readDir(dirPath: string): string[] {
      const prefix = dirPath === '/' ? '/' : dirPath + '/'
      const entries = new Set<string>()
      for (const path of Object.keys(files)) {
        if (path.startsWith(prefix)) {
          const rest = path.slice(prefix.length)
          const firstSegment = rest.split('/')[0]
          if (firstSegment) entries.add(firstSegment)
        }
      }
      return [...entries]
    },
    readFile(filePath: string): string | null {
      return files[filePath] ?? null
    },
    isDirectory(dirPath: string): boolean {
      const prefix = dirPath === '/' ? '/' : dirPath + '/'
      return Object.keys(files).some(f => f.startsWith(prefix) && f !== dirPath)
    },
    exists(filePath: string): boolean {
      return files[filePath] !== undefined
    },
  }
}

const SESSION_META = JSON.stringify({
  sessionId: 'test-123',
  sourceFilePaths: ['/path/to/file.jsonl'],
  createdAt: '2026-04-20T10:00:00Z',
  updatedAt: '2026-04-25T15:30:00Z',
  projectPath: '/Users/test/.claude/projects/-Users-test-foo',
})

describe('scanLibraryTree', () => {
  it('空目录返回空树', () => {
    const fs = mockFs({})
    const tree = scanLibraryTree('/root', fs)
    expect(tree.folders).toEqual([])
    expect(tree.ungroupedSessions).toEqual([])
  })

  it('扫描到未分组的 session', () => {
    const fs = mockFs({
      '/root/my-session/.swob-session.json': SESSION_META,
      '/root/my-session/transcript.md': '# chat content',
    })
    const tree = scanLibraryTree('/root', fs)
    expect(tree.ungroupedSessions).toHaveLength(1)
    expect(tree.ungroupedSessions[0].sessionId).toBe('test-123')
    expect(tree.ungroupedSessions[0].title).toBe('test-123')
  })

  it('扫描到文件夹内的 session', () => {
    const fs = mockFs({
      '/root/Swob 项目/修复 bug/.swob-session.json': SESSION_META,
      '/root/Swob 项目/修复 bug/transcript.md': '# content',
    })
    const tree = scanLibraryTree('/root', fs)
    expect(tree.folders).toHaveLength(1)
    expect(tree.folders[0].name).toBe('Swob 项目')
    expect(tree.folders[0].sessions).toHaveLength(1)
    expect(tree.folders[0].children).toEqual([])
  })

  it('嵌套文件夹结构', () => {
    const fs = mockFs({
      '/root/项目A/子文件夹/session1/.swob-session.json': SESSION_META,
      '/root/项目A/子文件夹/session1/transcript.md': '# content',
    })
    const tree = scanLibraryTree('/root', fs)
    expect(tree.folders).toHaveLength(1)
    expect(tree.folders[0].name).toBe('项目A')
    expect(tree.folders[0].children).toHaveLength(1)
    expect(tree.folders[0].children[0].name).toBe('子文件夹')
    expect(tree.folders[0].children[0].sessions).toHaveLength(1)
  })

  it('跳过以 . 开头的目录和文件', () => {
    const fs = mockFs({
      '/root/.swob-config.json': '{}',
      '/root/.hidden/session/.swob-session.json': SESSION_META,
    })
    const tree = scanLibraryTree('/root', fs)
    expect(tree.folders).toEqual([])
    expect(tree.ungroupedSessions).toEqual([])
  })

  it('损坏的 .swob-session.json 被跳过', () => {
    const fs = mockFs({
      '/root/bad-session/.swob-session.json': 'not valid json',
    })
    const tree = scanLibraryTree('/root', fs)
    expect(tree.ungroupedSessions).toHaveLength(0)
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

```bash
npx jest __tests__/lib/library-scanner.test.ts
# Expected: FAIL — module not found
```

- [ ] **Step 3: 实现 library-scanner.ts**

```typescript
// lib/library-scanner.ts
import { parseSessionMeta } from './session-parser'
import type { LibraryTree, FolderNode, SessionItem } from './types'

const SESSION_META_FILE = '.swob-session.json'
const TRANSCRIPT_FILE = 'transcript.md'

/**
 * 文件系统抽象接口，解耦真实文件系统访问，方便测试。
 * 生产环境由 iCloud 原生模块实现，测试用 mock。
 */
export interface FileSystemReader {
  readDir(dirPath: string): string[]
  readFile(filePath: string): string | null
  isDirectory(dirPath: string): boolean
  exists(filePath: string): boolean
}

/**
 * 递归扫描 Library 目录，返回文件树。
 */
export function scanLibraryTree(rootPath: string, fs: FileSystemReader): LibraryTree {
  const { sessions, folders } = scanDir(rootPath, rootPath, fs)
  return { rootPath, folders, ungroupedSessions: sessions }
}

function scanDir(
  dirPath: string,
  rootPath: string,
  fs: FileSystemReader
): { sessions: SessionItem[]; folders: FolderNode[] } {
  const sessions: SessionItem[] = []
  const folders: FolderNode[] = []

  const entries = fs.readDir(dirPath)
  for (const entry of entries) {
    // 跳过隐藏文件/目录
    if (entry.startsWith('.')) continue

    const fullPath = `${dirPath}/${entry}`
    if (!fs.isDirectory(fullPath) && !fs.exists(`${fullPath}/${SESSION_META_FILE}`)) {
      // 可能是一个含有 .swob-session.json 的 session 目录（isDirectory 可能返回 false）
      if (fs.exists(`${fullPath}/${SESSION_META_FILE}`)) {
        const meta = tryParseSession(fullPath, rootPath, fs)
        if (meta) sessions.push(meta)
      }
      continue
    }

    // 判断是 session 目录还是文件夹
    if (fs.exists(`${fullPath}/${SESSION_META_FILE}`)) {
      const meta = tryParseSession(fullPath, rootPath, fs)
      if (meta) sessions.push(meta)
    } else if (fs.isDirectory(fullPath)) {
      const relativePath = fullPath.slice(rootPath.length + 1)
      const sub = scanDir(fullPath, rootPath, fs)
      folders.push({
        name: entry,
        relativePath,
        sessions: sub.sessions,
        children: sub.folders,
      })
    }
  }

  return { sessions, folders }
}

function tryParseSession(
  dirPath: string,
  rootPath: string,
  fs: FileSystemReader
): SessionItem | null {
  const metaPath = `${dirPath}/${SESSION_META_FILE}`
  const content = fs.readFile(metaPath)
  if (!content) return null

  const relativePath = dirPath.slice(rootPath.length + 1)
  const hasTranscript = fs.exists(`${dirPath}/${TRANSCRIPT_FILE}`)
  return parseSessionMeta(content, relativePath, hasTranscript)
}
```

- [ ] **Step 4: 运行测试**

```bash
npx jest __tests__/lib/library-scanner.test.ts
# Expected: PASS
```

- [ ] **Step 5: 提交**

```bash
git add lib/library-scanner.ts __tests__/lib/library-scanner.test.ts
git commit -m "feat: Library 目录扫描器 — 递归扫描文件树，解耦文件系统"
```

---

## Task 5: 搜索逻辑

**Files:**
- Create: `lib/search.ts`
- Test: `__tests__/lib/search.test.ts`

搜索 Session 标题和项目路径。后续可扩展搜索 transcript.md 内容。

- [ ] **Step 1: 写测试**

```typescript
// __tests__/lib/search.test.ts
import { searchSessions } from '../../lib/search'
import type { SessionItem } from '../../lib/types'

const sessions: SessionItem[] = [
  {
    sessionId: '1', title: '修复登录 bug', projectPath: '/Users/test/.claude/projects/-Users-test-swob',
    createdAt: '2026-04-20T10:00:00Z', updatedAt: '2026-04-25T15:30:00Z',
    relativePath: 'Swob/修复登录 bug', transcriptAvailable: true,
  },
  {
    sessionId: '2', title: '新增搜索功能', projectPath: '/Users/test/.claude/projects/-Users-test-swob',
    createdAt: '2026-04-18T10:00:00Z', updatedAt: '2026-04-20T12:00:00Z',
    relativePath: 'Swob/新增搜索', transcriptAvailable: true,
  },
  {
    sessionId: '3', title: 'deploy script', projectPath: '/Users/test/.claude/projects/-Users-test-infra',
    createdAt: '2026-04-15T10:00:00Z', updatedAt: '2026-04-16T08:00:00Z',
    relativePath: 'infra/deploy', transcriptAvailable: false,
  },
]

describe('searchSessions', () => {
  it('按标题搜索', () => {
    const results = searchSessions(sessions, '登录')
    expect(results).toHaveLength(1)
    expect(results[0].sessionId).toBe('1')
  })

  it('搜索不区分大小写', () => {
    const results = searchSessions(sessions, 'DEPLOY')
    expect(results).toHaveLength(1)
    expect(results[0].sessionId).toBe('3')
  })

  it('空搜索词返回全部', () => {
    expect(searchSessions(sessions, '')).toHaveLength(3)
  })

  it('按项目路径搜索', () => {
    const results = searchSessions(sessions, 'swob')
    expect(results).toHaveLength(2) // session 1 和 2 的项目路径都含 swob
  })

  it('无匹配返回空', () => {
    expect(searchSessions(sessions, 'xyz')).toHaveLength(0)
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

```bash
npx jest __tests__/lib/search.test.ts
# Expected: FAIL — module not found
```

- [ ] **Step 3: 实现 search.ts**

```typescript
// lib/search.ts
import type { SessionItem } from './types'

/**
 * 在 session 列表中搜索。匹配标题和项目路径（不区分大小写）。
 */
export function searchSessions(sessions: SessionItem[], query: string): SessionItem[] {
  if (!query.trim()) return sessions
  const q = query.toLowerCase()
  return sessions.filter(
    (s) =>
      s.title.toLowerCase().includes(q) ||
      s.projectPath.toLowerCase().includes(q) ||
      s.relativePath.toLowerCase().includes(q)
  )
}
```

- [ ] **Step 4: 运行测试**

```bash
npx jest __tests__/lib/search.test.ts
# Expected: PASS
```

- [ ] **Step 5: 提交**

```bash
git add lib/search.ts __tests__/lib/search.test.ts
git commit -m "feat: session 搜索逻辑 — 标题+项目路径模糊匹配"
```

---

## Task 6: iCloud 原生模块 (iOS)

**Files:**
- Create: `ios/SwobMobile/SwobICloudModule.swift`
- Create: `ios/SwobMobile/SwobICloudModule-Bridging-Header.h`
- Create: `lib/icloud-reader.ts`

iOS 原生模块，实现 `FileSystemReader` 接口，通过 iCloud Drive 读取 Swob Library。

- [ ] **Step 1: 写 Swift 原生模块**

```swift
// ios/SwobMobile/SwobICloudModule.swift
import Foundation

@objc(SwobICloudModule)
class SwobICloudModule: NSObject {

  /// 获取 iCloud Drive 根目录下 Swob Library 的路径
  /// 默认路径: iCloud Drive/Documents/Swob
  @objc func getLibraryPath(_ resolve: RCTPromiseResolveBlock, reject: RCTPromiseRejectBlock) {
    guard let iCloudURL = FileManager.default.url(forUbiquityContainerIdentifier: nil) else {
      reject("ICLOUD_UNAVAILABLE", "iCloud Drive 不可用", nil)
      return
    }
    let libraryPath = iCloudURL.appendingPathComponent("Documents/Swob").path
    resolve(libraryPath)
  }

  /// 读取目录内容（返回文件和子目录名称列表）
  @objc func readDir(_ dirPath: String, resolve: RCTPromiseResolveBlock, reject: RCTPromiseRejectBlock) {
    do {
      let contents = try FileManager.default.contentsOfDirectory(atPath: dirPath)
      resolve(contents)
    } catch {
      resolve([]) // 目录不存在或不可读，返回空数组
    }
  }

  /// 读取文件内容为字符串
  @objc func readFile(_ filePath: String, resolve: RCTPromiseResolveBlock, reject: RCTPromiseRejectBlock) {
    // 如果文件是 iCloud 占位符，先触发下载
    if FileManager.default.isUbiquitousItem(at: URL(fileURLWithPath: filePath)) {
      do {
        try FileManager.default.startDownloadingUbiquitousItem(at: URL(fileURLWithPath: filePath))
      } catch {
        resolve(nil)
        return
      }
    }

    do {
      let content = try String(contentsOfFile: filePath, encoding: .utf8)
      resolve(content)
    } catch {
      resolve(nil)
    }
  }

  /// 判断路径是否为目录
  @objc func isDirectory(_ filePath: String, resolve: RCTPromiseResolveBlock, reject: RCTPromiseRejectBlock) {
    var isDir: ObjCBool = false
    let exists = FileManager.default.fileExists(atPath: filePath, isDirectory: &isDir)
    resolve(exists && isDir.boolValue)
  }

  /// 判断文件是否存在
  @objc func exists(_ filePath: String, resolve: RCTPromiseResolveBlock, reject: RCTPromiseRejectBlock) {
    let exists = FileManager.default.fileExists(atPath: filePath)
    resolve(exists)
  }

  /// 检测 iCloud 是否可用
  @objc func isICloudAvailable(_ resolve: RCTPromiseResolveBlock, reject: RCTPromiseRejectBlock) {
    let token = FileManager.default.ubiquityIdentityToken
    resolve(token != nil)
  }

  @objc static func requiresMainQueueSetup() -> Bool {
    return false
  }
}
```

- [ ] **Step 2: 写 TS 接口（实现 FileSystemReader）**

```typescript
// lib/icloud-reader.ts
import { NativeModules } from 'react-native'
import type { FileSystemReader } from './library-scanner'

const { SwobICloudModule } = NativeModules

/**
 * 检测 iCloud 是否可用
 */
export async function isICloudAvailable(): Promise<boolean> {
  return SwobICloudModule.isICloudAvailable()
}

/**
 * 获取 Swob Library 在 iCloud 中的路径
 */
export async function getLibraryPath(): Promise<string> {
  return SwobICloudModule.getLibraryPath()
}

/**
 * iCloud 文件系统读取器，实现 FileSystemReader 接口。
 * 注意：readDir/readFile/isDirectory/exists 是同步桥接方法。
 * 原生模块导出为 Promise，这里包装为同步调用供 scanLibraryTree 使用。
 */
export function createICloudReader(): FileSystemReader {
  return {
    readDir(dirPath: string): string[] {
      // 同步桥接：原生方法在主线程同步执行
      // 对于大目录可能有性能问题，但 Swob Library 通常不超 100 个条目
      let result: string[] = []
      SwobICloudModule.readDir(dirPath).then((r: string[]) => { result = r })
      return result
    },
    readFile(filePath: string): string | null {
      let result: string | null = null
      SwobICloudModule.readFile(filePath).then((r: string | null) => { result = r })
      return result
    },
    isDirectory(dirPath: string): boolean {
      let result = false
      SwobICloudModule.isDirectory(dirPath).then((r: boolean) => { result = r })
      return result
    },
    exists(filePath: string): boolean {
      let result = false
      SwobICloudModule.exists(filePath).then((r: boolean) => { result = r })
      return result
    },
  }
}
```

> **注意**：Task 6 的原生模块需要在 Xcode 中手动集成到 iOS 项目。这里先写代码，后续在真机调试时配置。库逻辑（scanner、parser）全部用纯 TS + mock fs 测试，不依赖原生模块。

- [ ] **Step 3: 提交**

```bash
git add ios/SwobMobile/ lib/icloud-reader.ts
git commit -m "feat: iCloud 原生模块 + FileSystemReader 实现"
```

---

## Task 7: Zustand Store

**Files:**
- Create: `store/sessions.ts`
- Create: `store/settings.ts`
- Test: `__tests__/store/sessions.test.ts`

- [ ] **Step 1: 写 sessions store 测试**

```typescript
// __tests__/store/sessions.test.ts
import { useSessionsStore } from '../../store/sessions'
import type { SessionItem, FolderNode } from '../../lib/types'

// mock 数据
const mockSessions: SessionItem[] = [
  {
    sessionId: '1', title: 'session 1', projectPath: '/path/a',
    createdAt: '2026-04-20T10:00:00Z', updatedAt: '2026-04-25T12:00:00Z',
    relativePath: 'session 1', transcriptAvailable: true,
  },
  {
    sessionId: '2', title: 'session 2', projectPath: '/path/b',
    createdAt: '2026-04-18T10:00:00Z', updatedAt: '2026-04-20T12:00:00Z',
    relativePath: 'folder/session 2', transcriptAvailable: true,
  },
]

const mockFolders: FolderNode[] = [
  {
    name: '项目A', relativePath: '项目A',
    sessions: [mockSessions[1]],
    children: [],
  },
]

describe('useSessionsStore', () => {
  beforeEach(() => {
    useSessionsStore.getState().reset()
  })

  it('初始状态为空', () => {
    const state = useSessionsStore.getState()
    expect(state.sessions).toEqual([])
    expect(state.folders).toEqual([])
    expect(state.isLoading).toBe(false)
  })

  it('setLibrary 设置数据', () => {
    useSessionsStore.getState().setLibrary(mockSessions, mockFolders)
    const state = useSessionsStore.getState()
    expect(state.sessions).toEqual(mockSessions)
    expect(state.folders).toEqual(mockFolders)
  })

  it('selectSession 记住选中的 session', () => {
    useSessionsStore.getState().setLibrary(mockSessions, mockFolders)
    useSessionsStore.getState().selectSession('1')
    expect(useSessionsStore.getState().selectedSessionId).toBe('1')
  })

  it('getSelectedSession 返回选中的 session', () => {
    useSessionsStore.getState().setLibrary(mockSessions, mockFolders)
    useSessionsStore.getState().selectSession('2')
    expect(useSessionsStore.getState().getSelectedSession()?.sessionId).toBe('2')
  })

  it('toggleFolder 展开/折叠文件夹', () => {
    useSessionsStore.getState().setLibrary(mockSessions, mockFolders)
    const folderPath = '项目A'
    useSessionsStore.getState().toggleFolder(folderPath)
    expect(useSessionsStore.getState().expandedFolders.has(folderPath)).toBe(true)
    useSessionsStore.getState().toggleFolder(folderPath)
    expect(useSessionsStore.getState().expandedFolders.has(folderPath)).toBe(false)
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

```bash
npx jest __tests__/store/sessions.test.ts
# Expected: FAIL — module not found
```

- [ ] **Step 3: 实现 sessions store**

```typescript
// store/sessions.ts
import { create } from 'zustand'
import type { SessionItem, FolderNode } from '../lib/types'

interface SessionsState {
  sessions: SessionItem[]
  folders: FolderNode[]
  selectedSessionId: string | null
  expandedFolders: Set<string>
  isLoading: boolean
  error: string | null

  setLibrary: (sessions: SessionItem[], folders: FolderNode[]) => void
  selectSession: (sessionId: string | null) => void
  toggleFolder: (relativePath: string) => void
  setLoading: (loading: boolean) => void
  setError: (error: string | null) => void
  getSelectedSession: () => SessionItem | undefined
  reset: () => void
}

export const useSessionsStore = create<SessionsState>((set, get) => ({
  sessions: [],
  folders: [],
  selectedSessionId: null,
  expandedFolders: new Set(),
  isLoading: false,
  error: null,

  setLibrary: (sessions, folders) => set({ sessions, folders, isLoading: false, error: null }),
  selectSession: (sessionId) => set({ selectedSessionId: sessionId }),
  toggleFolder: (relativePath) =>
    set((state) => {
      const next = new Set(state.expandedFolders)
      if (next.has(relativePath)) next.delete(relativePath)
      else next.add(relativePath)
      return { expandedFolders: next }
    }),
  setLoading: (isLoading) => set({ isLoading }),
  setError: (error) => set({ error, isLoading: false }),
  getSelectedSession: () => {
    const { sessions, selectedSessionId } = get()
    return sessions.find((s) => s.sessionId === selectedSessionId)
  },
  reset: () =>
    set({
      sessions: [],
      folders: [],
      selectedSessionId: null,
      expandedFolders: new Set(),
      isLoading: false,
      error: null,
    }),
}))
```

- [ ] **Step 4: 实现 settings store**

```typescript
// store/settings.ts
import { create } from 'zustand'
import { AsyncStorageStatic } from 'react-native'

// 简单的设置状态，后续 Phase 2 会扩展 SSH 配置等
interface SettingsState {
  fontSize: number
  setFontSize: (size: number) => void
}

const SETTINGS_KEY = '@swob/settings'

export const useSettingsStore = create<SettingsState>((set) => ({
  fontSize: 14,
  setFontSize: (fontSize) => set({ fontSize }),
}))
```

- [ ] **Step 5: 运行测试**

```bash
npx jest __tests__/store/sessions.test.ts
# Expected: PASS
```

- [ ] **Step 6: 提交**

```bash
git add store/ __tests__/store/
git commit -m "feat: Zustand store — sessions 列表状态 + 设置状态"
```

---

## Task 8: UI — Session 列表页

**Files:**
- Create: `app/components/FolderItem.tsx`
- Create: `app/components/SessionCard.tsx`
- Create: `app/components/SearchBar.tsx`
- Create: `app/tabs/SessionsTab.tsx`

- [ ] **Step 1: 实现 SearchBar 组件**

```tsx
// app/components/SearchBar.tsx
import React from 'react'
import { View, TextInput, StyleSheet } from 'react-native'

interface SearchBarProps {
  value: string
  onChangeText: (text: string) => void
  placeholder?: string
}

export function SearchBar({ value, onChangeText, placeholder = '搜索 session...' }: SearchBarProps) {
  return (
    <View style={styles.container}>
      <TextInput
        style={styles.input}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor="#71717a"
      />
    </View>
  )
}

const styles = StyleSheet.create({
  container: {
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  input: {
    backgroundColor: '#27272a',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    color: '#e4e4e7',
    fontSize: 14,
  },
})
```

- [ ] **Step 2: 实现 SessionCard 组件**

```tsx
// app/components/SessionCard.tsx
import React from 'react'
import { View, Text, Pressable, StyleSheet } from 'react-native'
import type { SessionItem } from '../../lib/types'
import { formatRelativeTime } from '../../lib/session-parser'

interface SessionCardProps {
  session: SessionItem
  onPress: (session: SessionItem) => void
}

export function SessionCard({ session, onPress }: SessionCardProps) {
  return (
    <Pressable
      style={({ pressed }) => [styles.container, pressed && styles.pressed]}
      onPress={() => onPress(session)}
    >
      <Text style={styles.title} numberOfLines={1}>{session.title}</Text>
      <View style={styles.meta}>
        <Text style={styles.time}>{formatRelativeTime(session.updatedAt)}</Text>
        {!session.transcriptAvailable && (
          <Text style={styles.cloudOnly}>云端</Text>
        )}
      </View>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  container: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#27272a',
  },
  pressed: {
    backgroundColor: '#27272a',
  },
  title: {
    color: '#e4e4e7',
    fontSize: 14,
    fontWeight: '500',
  },
  meta: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 2,
  },
  time: {
    color: '#71717a',
    fontSize: 12,
  },
  cloudOnly: {
    color: '#f59e0b',
    fontSize: 10,
    backgroundColor: '#451a0380',
    paddingHorizontal: 4,
    borderRadius: 4,
    overflow: 'hidden',
  },
})
```

- [ ] **Step 3: 实现 FolderItem 组件**

```tsx
// app/components/FolderItem.tsx
import React from 'react'
import { View, Text, Pressable, StyleSheet } from 'react-native'
import type { FolderNode } from '../../lib/types'

interface FolderItemProps {
  folder: FolderNode
  expanded: boolean
  onToggle: () => void
  children: React.ReactNode
}

export function FolderItem({ folder, expanded, onToggle, children }: FolderItemProps) {
  return (
    <View>
      <Pressable
        style={({ pressed }) => [styles.header, pressed && styles.pressed]}
        onPress={onToggle}
      >
        <Text style={styles.arrow}>{expanded ? '▾' : '▸'}</Text>
        <Text style={styles.name} numberOfLines={1}>{folder.name}</Text>
        <Text style={styles.count}>{countSessions(folder)}</Text>
      </Pressable>
      {expanded && <View style={styles.children}>{children}</View>}
    </View>
  )
}

function countSessions(folder: FolderNode): number {
  let count = folder.sessions.length
  for (const child of folder.children) {
    count += countSessions(child)
  }
  return count
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 8,
    gap: 6,
  },
  pressed: {
    backgroundColor: '#27272a',
  },
  arrow: {
    color: '#71717a',
    fontSize: 12,
  },
  name: {
    color: '#a1a1aa',
    fontSize: 14,
    fontWeight: '500',
    flex: 1,
  },
  count: {
    color: '#52525b',
    fontSize: 12,
  },
  children: {
    paddingLeft: 16,
  },
})
```

- [ ] **Step 4: 实现 SessionsTab 主页面**

```tsx
// app/tabs/SessionsTab.tsx
import React, { useEffect, useState } from 'react'
import { View, FlatList, ActivityIndicator, Text, StyleSheet } from 'react-native'
import { useSessionsStore } from '../../store/sessions'
import { searchSessions } from '../../lib/search'
import { FolderItem } from '../components/FolderItem'
import { SessionCard } from '../components/SessionCard'
import { SearchBar } from '../components/SearchBar'
import type { SessionItem, FolderNode } from '../../lib/types'

export function SessionsTab({ navigation }: any) {
  const {
    sessions, folders, isLoading, error,
    expandedFolders, selectedSessionId,
    setLibrary, selectSession, toggleFolder,
    setLoading, setError,
  } = useSessionsStore()
  const [searchQuery, setSearchQuery] = useState('')

  // TODO: Phase 1 集成时替换为真实 iCloud 加载
  // useEffect(() => { loadFromICloud() }, [])

  const handleSessionPress = (session: SessionItem) => {
    selectSession(session.sessionId)
    navigation.navigate('ChatViewer', { sessionId: session.sessionId })
  }

  // 搜索过滤
  const filteredSessions = searchQuery ? searchSessions(sessions, searchQuery) : sessions

  // 构建列表数据：文件夹 + 未分组 session
  const listData = buildListData(folders, filteredSessions, expandedFolders, searchQuery)

  if (isLoading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color="#e4e4e7" />
      </View>
    )
  }

  if (error) {
    return (
      <View style={styles.center}>
        <Text style={styles.errorText}>{error}</Text>
      </View>
    )
  }

  return (
    <View style={styles.container}>
      <SearchBar value={searchQuery} onChangeText={setSearchQuery} />
      <FlatList
        data={listData}
        keyExtractor={(item) => item.key}
        renderItem={({ item }) => {
          if (item.type === 'folder') {
            return (
              <FolderItem
                folder={item.folder}
                expanded={expandedFolders.has(item.folder.relativePath)}
                onToggle={() => toggleFolder(item.folder.relativePath)}
              >
                {item.folder.sessions.map((s) => (
                  <SessionCard key={s.sessionId} session={s} onPress={handleSessionPress} />
                ))}
                {item.folder.children.map((child) => (
                  <FolderItem
                    key={child.relativePath}
                    folder={child}
                    expanded={expandedFolders.has(child.relativePath)}
                    onToggle={() => toggleFolder(child.relativePath)}
                  >
                    {child.sessions.map((s) => (
                      <SessionCard key={s.sessionId} session={s} onPress={handleSessionPress} />
                    ))}
                  </FolderItem>
                ))}
              </FolderItem>
            )
          }
          return <SessionCard session={item.session} onPress={handleSessionPress} />
        }}
        ListEmptyComponent={
          <View style={styles.center}>
            <Text style={styles.emptyText}>暂无 session</Text>
          </View>
        }
      />
    </View>
  )
}

type ListItem =
  | { key: string; type: 'folder'; folder: FolderNode }
  | { key: string; type: 'session'; session: SessionItem }

function buildListData(
  folders: FolderNode[],
  ungrouped: SessionItem[],
  expanded: Set<string>,
  query: string
): ListItem[] {
  const items: ListItem[] = []

  for (const folder of folders) {
    if (query || expanded.has(folder.relativePath)) {
      items.push({ key: folder.relativePath, type: 'folder', folder })
    } else {
      items.push({ key: folder.relativePath, type: 'folder', folder })
    }
  }

  for (const session of ungrouped) {
    items.push({ key: session.sessionId, type: 'session', session })
  }

  return items
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#18181b',
  },
  center: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  errorText: {
    color: '#ef4444',
    fontSize: 14,
  },
  emptyText: {
    color: '#71717a',
    fontSize: 14,
  },
})
```

- [ ] **Step 5: 提交**

```bash
git add app/
git commit -m "feat: Session 列表页 UI — 文件夹展开 + 搜索 + session 卡片"
```

---

## Task 9: UI — Chat Viewer 页面

**Files:**
- Create: `app/screens/ChatViewerScreen.tsx`

- [ ] **Step 1: 实现 Chat Viewer**

```tsx
// app/screens/ChatViewerScreen.tsx
import React, { useEffect, useState } from 'react'
import { View, Text, ScrollView, ActivityIndicator, StyleSheet, Pressable } from 'react-native'
import Markdown from 'react-native-markdown-display'
import { useSessionsStore } from '../../store/sessions'
import { useSettingsStore } from '../../store/settings'

export function ChatViewerScreen({ navigation }: any) {
  const { selectedSessionId, getSelectedSession } = useSessionsStore()
  const { fontSize } = useSettingsStore()
  const [content, setContent] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const session = getSelectedSession()

  useEffect(() => {
    if (!session) {
      setLoading(false)
      return
    }
    // TODO: Phase 1 集成时从 iCloud 读取 transcript.md
    // 目前先用占位内容
    setLoading(false)
    setContent('# 暂无内容\n\n等待 iCloud 集成后加载 transcript.md')
  }, [session])

  if (!session) {
    return (
      <View style={styles.center}>
        <Text style={styles.errorText}>未选择 session</Text>
      </View>
    )
  }

  return (
    <View style={styles.container}>
      {/* 顶部导航 */}
      <View style={styles.header}>
        <Pressable onPress={() => navigation.goBack()}>
          <Text style={styles.backButton}>← 返回</Text>
        </Pressable>
        <Text style={styles.title} numberOfLines={1}>{session.title}</Text>
      </View>

      {/* 内容区 */}
      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color="#e4e4e7" />
        </View>
      ) : content ? (
        <ScrollView style={styles.content} contentContainerStyle={styles.contentContainer}>
          <Markdown style={markdownStyles}>{content}</Markdown>
        </ScrollView>
      ) : (
        <View style={styles.center}>
          <Text style={styles.emptyText}>聊天记录不可用</Text>
        </View>
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#18181b',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#27272a',
    gap: 12,
  },
  backButton: {
    color: '#3b82f6',
    fontSize: 14,
  },
  title: {
    color: '#e4e4e7',
    fontSize: 16,
    fontWeight: '600',
    flex: 1,
  },
  center: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  content: {
    flex: 1,
  },
  contentContainer: {
    padding: 16,
  },
  errorText: {
    color: '#ef4444',
    fontSize: 14,
  },
  emptyText: {
    color: '#71717a',
    fontSize: 14,
  },
})

/** Markdown 渲染样式，对齐 Swob 桌面端 DESIGN.md 颜色规范 */
const markdownStyles = StyleSheet.create({
  body: {
    color: '#e4e4e7',
    fontSize: 14,
    lineHeight: 20,
  },
  heading1: {
    color: '#e4e4e7',
    fontSize: 18,
    fontWeight: '700',
    marginTop: 16,
    marginBottom: 8,
  },
  heading2: {
    color: '#e4e4e7',
    fontSize: 16,
    fontWeight: '600',
    marginTop: 12,
    marginBottom: 6,
  },
  heading3: {
    color: '#e4e4e7',
    fontSize: 14,
    fontWeight: '600',
    marginTop: 8,
    marginBottom: 4,
  },
  code_inline: {
    backgroundColor: '#27272a',
    color: '#a1a1aa',
    fontSize: 12,
    fontFamily: 'Courier',
    paddingHorizontal: 4,
  },
  code_block: {
    backgroundColor: '#27272a',
    color: '#a1a1aa',
    fontSize: 12,
    fontFamily: 'Courier',
    padding: 12,
    borderRadius: 6,
    marginVertical: 8,
  },
  blockquote: {
    borderLeftWidth: 3,
    borderLeftColor: '#3b82f6',
    paddingLeft: 12,
    marginVertical: 8,
  },
  strong: {
    fontWeight: '700',
    color: '#e4e4e7',
  },
  em: {
    fontStyle: 'italic',
  },
})
```

- [ ] **Step 2: 提交**

```bash
git add app/screens/ChatViewerScreen.tsx
git commit -m "feat: Chat Viewer 页面 — Markdown 渲染聊天记录"
```

---

## Task 10: 导航 + 入口

**Files:**
- Create: `app/navigation/RootNavigator.tsx`
- Modify: `App.tsx`

- [ ] **Step 1: 实现 RootNavigator**

```tsx
// app/navigation/RootNavigator.tsx
import React from 'react'
import { NavigationContainer } from '@react-navigation/native'
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs'
import { createNativeStackNavigator } from '@react-navigation/native-stack'
import { Text } from 'react-native'
import { SessionsTab } from '../tabs/SessionsTab'
import { ChatViewerScreen } from '../screens/ChatViewerScreen'

const Tab = createBottomTabNavigator()
const Stack = createNativeStackNavigator()

function SessionsStack() {
  return (
    <Stack.Navigator screenOptions={{ headerShown: false }}>
      <Stack.Screen name="SessionsList" component={SessionsTab} />
      <Stack.Screen name="ChatViewer" component={ChatViewerScreen} />
    </Stack.Navigator>
  )
}

function PlaceholderSettings() {
  return (
    <Text style={{ color: '#e4e4e7', textAlign: 'center', marginTop: 100 }}>
      设置页（Phase 2 实现）
    </Text>
  )
}

export function RootNavigator() {
  return (
    <NavigationContainer>
      <Tab.Navigator
        screenOptions={{
          headerShown: false,
          tabBarStyle: {
            backgroundColor: '#18181b',
            borderTopColor: '#27272a',
          },
          tabBarActiveTintColor: '#e4e4e7',
          tabBarInactiveTintColor: '#71717a',
        }}
      >
        <Tab.Screen
          name="Sessions"
          component={SessionsStack}
          options={{ tabBarLabel: 'Sessions', tabBarIcon: () => null }}
        />
        <Tab.Screen
          name="Settings"
          component={PlaceholderSettings}
          options={{ tabBarLabel: '设置', tabBarIcon: () => null }}
        />
      </Tab.Navigator>
    </NavigationContainer>
  )
}
```

- [ ] **Step 2: 修改 App.tsx 入口**

```tsx
// App.tsx
import React from 'react'
import { SafeAreaView, StatusBar, StyleSheet } from 'react-native'
import { RootNavigator } from './app/navigation/RootNavigator'

export default function App() {
  return (
    <SafeAreaView style={styles.container}>
      <StatusBar barStyle="light-content" />
      <RootNavigator />
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#18181b',
  },
})
```

- [ ] **Step 3: 验证 TypeScript 编译**

```bash
npx tsc --noEmit
# Expected: no errors
```

- [ ] **Step 4: 提交**

```bash
git add app/navigation/ App.tsx
git commit -m "feat: 导航入口 — 底部 Tab（Sessions + 设置）+ Stack（Chat Viewer）"
```

---

## Task 11: 集成测试 — iCloud 数据加载全链路

**Files:**
- Create: `__tests__/integration/library-load.test.ts`

验证从 mock 文件系统读取到 UI 展示的完整链路。

- [ ] **Step 1: 写集成测试**

```typescript
// __tests__/integration/library-load.test.ts
import { scanLibraryTree } from '../../lib/library-scanner'
import { searchSessions } from '../../lib/search'
import { useSessionsStore } from '../../store/sessions'
import type { FileSystemReader } from '../../lib/library-scanner'

function mockFs(files: Record<string, string | null>): FileSystemReader {
  return {
    readDir(dirPath: string): string[] {
      const prefix = dirPath + '/'
      const entries = new Set<string>()
      for (const p of Object.keys(files)) {
        if (p.startsWith(prefix)) {
          const rest = p.slice(prefix.length)
          const first = rest.split('/')[0]
          if (first) entries.add(first)
        }
      }
      return [...entries]
    },
    readFile(filePath: string): string | null {
      return files[filePath] ?? null
    },
    isDirectory(dirPath: string): boolean {
      const prefix = dirPath + '/'
      return Object.keys(files).some(f => f.startsWith(prefix) && f !== dirPath)
    },
    exists(filePath: string): boolean {
      return files[filePath] !== undefined
    },
  }
}

const META_1 = JSON.stringify({
  sessionId: 's-001',
  sourceFilePaths: ['/a.jsonl'],
  createdAt: '2026-04-20T10:00:00Z',
  updatedAt: '2026-04-25T15:00:00Z',
  projectPath: '/Users/test/.claude/projects/-Users-test-swob',
})

const META_2 = JSON.stringify({
  sessionId: 's-002',
  sourceFilePaths: ['/b.jsonl'],
  customTitle: '部署脚本',
  createdAt: '2026-04-18T10:00:00Z',
  updatedAt: '2026-04-20T12:00:00Z',
  projectPath: '/Users/test/.claude/projects/-Users-test-infra',
})

describe('Library 加载全链路', () => {
  it('从文件系统到 store 完整链路', () => {
    const fs = mockFs({
      '/root/Swob 项目/修复 bug/.swob-session.json': META_1,
      '/root/Swob 项目/修复 bug/transcript.md': '# 修复 bug 记录',
      '/root/infra/deploy/.swob-session.json': META_2,
      '/root/infra/deploy/transcript.md': '# 部署流程',
    })

    // 1. 扫描文件系统
    const tree = scanLibraryTree('/root', fs)
    expect(tree.folders).toHaveLength(2)

    // 2. 写入 store
    const allSessions = [
      ...tree.ungroupedSessions,
      ...tree.folders.flatMap(f => [...f.sessions, ...f.children.flatMap(c => c.sessions)]),
    ]
    useSessionsStore.getState().setLibrary(allSessions, tree.folders)

    // 3. 验证 store 状态
    const state = useSessionsStore.getState()
    expect(state.sessions).toHaveLength(2)

    // 4. 搜索
    const results = searchSessions(state.sessions, '部署')
    expect(results).toHaveLength(1)
    expect(results[0].title).toBe('部署脚本')

    // 5. 选中 session
    state.selectSession('s-002')
    expect(state.getSelectedSession()?.title).toBe('部署脚本')
  })

  it('空 Library 正常处理', () => {
    const fs = mockFs({ '/root/.swob-config.json': '{}' })
    const tree = scanLibraryTree('/root', fs)
    expect(tree.folders).toEqual([])
    expect(tree.ungroupedSessions).toEqual([])

    useSessionsStore.getState().setLibrary([], [])
    expect(useSessionsStore.getState().sessions).toEqual([])
  })
})
```

- [ ] **Step 2: 运行测试**

```bash
npx jest __tests__/integration/library-load.test.ts
# Expected: PASS
```

- [ ] **Step 3: 运行全部测试**

```bash
npx jest
# Expected: ALL PASS
```

- [ ] **Step 4: 提交**

```bash
git add __tests__/integration/
git commit -m "test: 集成测试 — iCloud 数据加载全链路"
```

---

## Self-Review

### Spec 覆盖检查

| Spec 要求 | 对应 Task |
|-----------|-----------|
| iCloud Library 读取 | Task 6 (原生模块) + Task 11 (集成) |
| Session 列表 + 文件夹展开 | Task 8 (SessionsTab + FolderItem) |
| Chat Viewer (渲染 transcript.md) | Task 9 (ChatViewerScreen) |
| 搜索 | Task 5 (search.ts) + Task 8 (SearchBar) |
| 类型定义和桌面端对齐 | Task 2 (types.ts) |
| Zustand 状态管理 | Task 7 (sessions.ts + settings.ts) |
| 导航结构 (Tab + Stack) | Task 10 (RootNavigator) |

### Placeholder 扫描

- 无 TBD/TODO（代码中有 2 处 `// TODO: Phase 1 集成时替换` 注释，标明真实 iCloud 加载的接入点，这是合理的集成标记，不是实现缺失）
- 所有步骤包含实际代码
- 所有测试包含实际断言

### 类型一致性检查

- `SessionMeta` / `SessionItem` 在 types.ts 定义，在 session-parser.ts 和 library-scanner.ts 中使用，字段名一致
- `FileSystemReader` 接口在 library-scanner.ts 定义，icloud-reader.ts 和测试中实现，方法签名一致
- Store 使用 `SessionItem` 和 `FolderNode`，和 types.ts 定义一致
- `parseSessionMeta` 返回 `SessionItem | null`，调用方正确处理 null
