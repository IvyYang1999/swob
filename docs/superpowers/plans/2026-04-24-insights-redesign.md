# Insights 重设计 + 文件夹视图切换 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 Insights 洞察页重做为仪表盘网格布局，新增每日洞察时间轴和时间统计；新增全局项目视图切换设置。

**Architecture:** 数据层（insights.ts）新增时间估算函数和扩展 InsightsData；UI 层将 InsightsPage 拆分为 7 个独立组件；引入 Recharts 图表库；SettingsPanel 和 Sidebar 新增项目视图切换。

**Tech Stack:** Electron + React 19 + TypeScript + Zustand + Tailwind CSS v4 + Recharts

---

## File Structure

```
新建:
  src/renderer/src/components/insights/
    InsightsPage.tsx          # 主页面布局编排
    StatsCards.tsx            # 5 个统计卡片
    TokenHeatmap.tsx          # 365 天热力图（从旧 InsightsPage 迁移）
    SourceDonut.tsx           # 来源环形图（Recharts PieChart）
    ProjectRanking.tsx        # 项目排行 Top 10
    DailyTrend.tsx            # 30 天趋势（Recharts AreaChart）
    DailyTimeline.tsx         # 每日洞察时间轴
    shared.ts                 # 共享类型和工具函数

修改:
  src/main/types.ts           # SessionSummary 新增 estimatedTime
  src/main/insights.ts        # 新增 estimateActiveTime, 扩展 DateStats/InsightsData
  src/main/insights.test.ts   # 新增测试用例
  src/main/session-loader.ts  # buildSessionSummary 计算 estimatedTime
  src/main/index.ts           # insights:get IPC 传入时间数据
  src/renderer/src/store.ts   # preferences 新增 projectViewMode
  src/renderer/src/components/SettingsPanel.tsx  # 新增项目视图设置项
  src/renderer/src/components/Sidebar.tsx        # paths 模式下自动生成项目树
  src/renderer/src/components/InsightsPage.tsx   # 删除（迁移到 insights/）
  src/renderer/src/App.tsx     # 更新 import 路径
  src/renderer/src/i18n.ts    # 新增翻译 key
```

---

### Task 1: 数据层 — 新增 estimateActiveTime 和扩展类型

**Files:**
- Modify: `src/main/types.ts` (SessionSummary 新增 estimatedTime)
- Modify: `src/main/insights.ts` (新增 estimateActiveTime, 扩展 DateStats/InsightsData)
- Modify: `src/main/insights.test.ts` (新增测试)

- [ ] **Step 1: 在 types.ts 的 SessionSummary 新增 estimatedTime 字段**

在 `src/main/types.ts` 的 `SessionSummary` 接口中，`allUserMessages` 之后添加:

```typescript
  estimatedTime?: number  // 预估活跃时间（毫秒），相邻消息间隔累加，30min 截断
```

- [ ] **Step 2: 在 insights.ts 新增 estimateActiveTime 函数和扩展 DateStats/InsightsData**

在 `src/main/insights.ts` 中:

1. 新增导入 `ParsedMessage`:
```typescript
import type { SessionSummary, Folder, ParsedMessage } from './types'
```

2. 新增 `estimateActiveTime` 函数（在 `buildInsights` 之前）:
```typescript
const THIRTY_MINUTES = 30 * 60 * 1000

/** 相邻消息间隔累加，超过 30 分钟无消息截断 */
export function estimateActiveTime(messages: ParsedMessage[]): number {
  if (messages.length < 2) return 0
  const sorted = [...messages].sort((a, b) =>
    new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
  )
  let total = 0
  for (let i = 1; i < sorted.length; i++) {
    const gap = new Date(sorted[i].timestamp).getTime() - new Date(sorted[i - 1].timestamp).getTime()
    if (gap > 0 && gap < THIRTY_MINUTES) {
      total += gap
    }
  }
  return total
}
```

3. 扩展 `DateStats` 接口，新增 `totalTime` 和 `byProjectTime`:
```typescript
export interface DateStats {
  date: string
  totalTokens: number
  inputTokens: number
  outputTokens: number
  sessionCount: number
  turnCount: number
  bySource: Record<string, number>
  byProject: Record<string, number>
  totalTime: number                       // 新增
  byProjectTime: Record<string, number>   // 新增
}
```

4. 扩展 `InsightsData` 接口，新增 `totalTime` 和 `activeDays`:
```typescript
export interface InsightsData {
  totalTokens: number
  totalInputTokens: number
  totalOutputTokens: number
  totalSessions: number
  totalTurns: number
  totalTime: number                       // 新增: 总活跃时间（毫秒）
  activeDays: number                      // 新增: 有记录的天数
  bySource: SourceStats[]
  byProject: ProjectStats[]
  byFolder: FolderStats[]
  byDate: DateStats[]
  heatmap: HeatmapEntry[]
}
```

5. 更新 `emptyDateStats`:
```typescript
function emptyDateStats(date: string): DateStats {
  return {
    date,
    totalTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    sessionCount: 0,
    turnCount: 0,
    bySource: {},
    byProject: {},
    totalTime: 0,
    byProjectTime: {}
  }
}
```

6. 更新 `buildInsights`:
- 新增参数 `sessionTimes: Map<string, number>` (sessionId → estimatedTime)
- 签名变为:
```typescript
export function buildInsights(
  sessions: SessionSummary[],
  folders: Folder[],
  sessionTimes?: Map<string, number>
): InsightsData {
```
- 在循环中累加 `totalTime`:
```typescript
let totalTime = 0

// 在 session 循环中:
const estTime = sessionTimes?.get(session.sessionId) || session.estimatedTime || 0
totalTime += estTime

// 日期统计中:
dateStats.totalTime += estTime
const projTimeKey = project
dateStats.byProjectTime[projTimeKey] = (dateStats.byProjectTime[projTimeKey] || 0) + estTime
```
- 计算 `activeDays`:
```typescript
const activeDays = byDate.filter(d => d.totalTokens > 0).length
```
- 返回值新增:
```typescript
return {
  ...
  totalTime,
  activeDays,
  ...
}
```

- [ ] **Step 3: 写测试 — estimateActiveTime**

在 `src/main/insights.test.ts` 中新增:

```typescript
describe('estimateActiveTime', () => {
  it('空消息返回 0', () => {
    expect(estimateActiveTime([])).toBe(0)
  })

  it('单条消息返回 0', () => {
    expect(estimateActiveTime([
      { timestamp: '2025-06-01T10:00:00Z' } as any
    ])).toBe(0)
  })

  it('正常消息序列累加间隔', () => {
    const messages = [
      { timestamp: '2025-06-01T10:00:00Z' },
      { timestamp: '2025-06-01T10:05:00Z' },  // +5min
      { timestamp: '2025-06-01T10:10:00Z' },  // +5min
    ] as any[]
    // 10min = 600000ms
    expect(estimateActiveTime(messages)).toBe(600_000)
  })

  it('超过 30 分钟的间隔被截断', () => {
    const messages = [
      { timestamp: '2025-06-01T10:00:00Z' },
      { timestamp: '2025-06-01T10:05:00Z' },  // +5min = 300000ms
      { timestamp: '2025-06-01T11:00:00Z' },  // 55min gap → 截断为 0
      { timestamp: '2025-06-01T11:05:00Z' },  // +5min = 300000ms
    ] as any[]
    expect(estimateActiveTime(messages)).toBe(600_000)
  })

  it('无序消息也能正确计算（按时间排序）', () => {
    const messages = [
      { timestamp: '2025-06-01T10:10:00Z' },
      { timestamp: '2025-06-01T10:00:00Z' },
      { timestamp: '2025-06-01T10:05:00Z' },
    ] as any[]
    expect(estimateActiveTime(messages)).toBe(600_000)
  })
})
```

- [ ] **Step 4: 写测试 — buildInsights 新增字段**

在 `src/main/insights.test.ts` 的 `buildInsights` describe 中新增:

```typescript
describe('新增时间字段', () => {
  it('totalTime 和 activeDays 正确计算', () => {
    const today = new Date().toISOString().slice(0, 10)
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10)
    const sessions = [
      makeSession({ sessionId: 's1', updatedAt: `${today}T10:00:00Z` }),
      makeSession({ sessionId: 's2', updatedAt: `${yesterday}T10:00:00Z` }),
    ]
    const sessionTimes = new Map<string, number>()
    sessionTimes.set('s1', 600_000)   // 10 min
    sessionTimes.set('s2', 1_800_000) // 30 min
    const result = buildInsights(sessions, [], sessionTimes)

    expect(result.totalTime).toBe(2_400_000)
    expect(result.activeDays).toBe(2)
  })

  it('byDate 包含 totalTime 和 byProjectTime', () => {
    const today = new Date().toISOString().slice(0, 10)
    const sessions = [
      makeSession({ sessionId: 's1', updatedAt: `${today}T10:00:00Z`, cwds: ['/a/swob'] }),
    ]
    const sessionTimes = new Map<string, number>()
    sessionTimes.set('s1', 600_000)
    const result = buildInsights(sessions, [], sessionTimes)
    const todayStats = result.byDate.find(d => d.date === today)!

    expect(todayStats.totalTime).toBe(600_000)
    expect(todayStats.byProjectTime['swob']).toBe(600_000)
  })

  it('空 sessions totalTime 为 0, activeDays 为 0', () => {
    const result = buildInsights([], [])
    expect(result.totalTime).toBe(0)
    expect(result.activeDays).toBe(0)
  })
})
```

- [ ] **Step 5: 运行测试**

Run: `npm test`
Expected: 所有测试通过（包括新增的 estimateActiveTime 和 buildInsights 时间字段测试）

- [ ] **Step 6: Commit**

```bash
git add src/main/types.ts src/main/insights.ts src/main/insights.test.ts
git commit -m "feat: insights 数据层新增时间估算和活跃天数统计"
```

---

### Task 2: session-loader 计算 estimatedTime 并传入 IPC

**Files:**
- Modify: `src/main/session-loader.ts` (buildSessionSummary 计算 estimatedTime)
- Modify: `src/main/index.ts` (insights:get IPC 传入时间数据)

- [ ] **Step 1: 在 session-loader.ts 的 buildSessionSummary 中计算 estimatedTime**

找到 `buildSessionSummary` 函数，导入 `estimateActiveTime`:
```typescript
import { estimateActiveTime } from './insights'
```

在生成 `SessionSummary` 对象时，添加 `estimatedTime` 字段。在 `validMessages` 已经解析好的地方:
```typescript
estimatedTime: estimateActiveTime(parsedMessages),
```

注意: `parsedMessages` 是 `ParsedMessage[]`，来自 JSONL 解析过程。找到函数中已经存在的解析后的消息列表，传给 `estimateActiveTime`。

- [ ] **Step 2: 更新 insights:get IPC handler**

在 `src/main/index.ts` 的 `insights:get` handler 中，从 `cachedSessions` 收集 `sessionTimes`:

```typescript
ipcMain.handle('insights:get', () => {
  const sessions = cachedSessions
  let folders: Array<{ id: string; name: string; parentId?: string | null; sessionIds: string[] }> = []
  try {
    if (libraryInitialized) {
      const tree = scanLibrary()
      const cfg = libraryTreeToConfig(tree)
      folders = cfg.folders || []
    } else {
      const cfg = loadConfig()
      folders = cfg.folders || []
    }
  } catch { /* ignore */ }
  const sessionTimes = new Map<string, number>()
  for (const s of sessions) {
    if (s.estimatedTime) sessionTimes.set(s.sessionId, s.estimatedTime)
  }
  return buildInsights(sessions, folders, sessionTimes)
})
```

- [ ] **Step 3: 运行测试**

Run: `npm test`
Expected: 所有测试通过

- [ ] **Step 4: Commit**

```bash
git add src/main/session-loader.ts src/main/index.ts
git commit -m "feat: session-loader 计算 estimatedTime 并传入 insights IPC"
```

---

### Task 3: Store 和类型 — 新增 projectViewMode

**Files:**
- Modify: `src/main/types.ts` (UserConfig.preferences 新增 projectViewMode)
- Modify: `src/renderer/src/store.ts` (preferences 类型 + 新增 projectViewMode state)

- [ ] **Step 1: 在 types.ts 的 UserConfig.preferences 新增字段**

```typescript
export interface UserConfig {
  folders: Folder[]
  sessionMeta: Record<string, {
    customTitle?: string
    notes?: string
    highlights?: Highlight[]
  }>
  preferences: {
    defaultViewMode: 'compact' | 'full'
    terminalApp: 'Terminal' | 'iTerm2'
    locale?: 'zh-CN' | 'en'
    themeMode?: ThemeMode
    spotlightShortcut?: string
    sshConfig?: SshConfig
    projectViewMode?: 'folders' | 'paths'   // 新增
  }
}
```

- [ ] **Step 2: 在 store.ts 的 preferences 类型中添加 projectViewMode**

在 `store.ts` 中的 `UserConfig` interface 的 preferences 里添加:
```typescript
    projectViewMode?: 'folders' | 'paths'
```

不需要在 AppState 中添加独立 state — projectViewMode 直接从 `config?.preferences?.projectViewMode` 读取。

- [ ] **Step 3: 运行测试**

Run: `npm test`
Expected: 所有测试通过

- [ ] **Step 4: Commit**

```bash
git add src/main/types.ts src/renderer/src/store.ts
git commit -m "feat: 新增 projectViewMode 设置字段"
```

---

### Task 4: 安装 Recharts

**Files:**
- Modify: `package.json` (新增 recharts 依赖)

- [ ] **Step 1: 安装 recharts**

Run: `npm install recharts`

- [ ] **Step 2: 验证编译**

Run: `npx electron-vite build`
Expected: 编译通过

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: 安装 recharts 图表库"
```

---

### Task 5: UI — 创建 insights 组件目录和共享模块

**Files:**
- Create: `src/renderer/src/components/insights/shared.ts`

- [ ] **Step 1: 创建 shared.ts — 共享类型和工具函数**

```typescript
export function formatTokenCount(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

export function formatDuration(ms: number): string {
  if (ms === 0) return '0m'
  const hours = Math.floor(ms / 3_600_000)
  const minutes = Math.floor((ms % 3_600_000) / 60_000)
  if (hours > 0) return `${hours}h ${minutes}m`
  return `${minutes}m`
}

export const SOURCE_COLORS: Record<string, string> = {
  'claude-code': '#f59e0b',
  codex: '#3b82f6',
  cursor: '#a1a1aa',
}

export const PROJECT_COLORS = [
  '#8b5cf6', '#3b82f6', '#10b981', '#f59e0b', '#ef4444',
  '#ec4899', '#06b6d4', '#84cc16', '#f97316', '#6366f1',
]

export interface InsightsData {
  totalTokens: number
  totalInputTokens: number
  totalOutputTokens: number
  totalSessions: number
  totalTurns: number
  totalTime: number
  activeDays: number
  bySource: BySource[]
  byProject: ByProject[]
  byFolder: ByFolder[]
  byDate: ByDate[]
  heatmap: HeatmapCell[]
}

export interface BySource {
  source: string
  label: string
  totalTokens: number
  inputTokens: number
  outputTokens: number
  sessionCount: number
  turnCount: number
}

export interface ByProject {
  project: string
  fullPath: string
  totalTokens: number
  inputTokens: number
  outputTokens: number
  sessionCount: number
  turnCount: number
  sources: string[]
}

export interface ByFolder {
  folderId: string
  folderName: string
  totalTokens: number
  inputTokens: number
  outputTokens: number
  sessionCount: number
  turnCount: number
}

export interface ByDate {
  date: string
  totalTokens: number
  inputTokens: number
  outputTokens: number
  sessionCount: number
  turnCount: number
  bySource: Record<string, number>
  byProject: Record<string, number>
  totalTime: number
  byProjectTime: Record<string, number>
}

export interface HeatmapCell {
  date: string
  value: number
  level: 0 | 1 | 2 | 3 | 4
}
```

- [ ] **Step 2: 创建 insights 组件目录**

Run: `mkdir -p src/renderer/src/components/insights`

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/components/insights/shared.ts
git commit -m "feat: insights 共享类型和工具函数"
```

---

### Task 6: UI — 迁移热力图组件 (TokenHeatmap)

**Files:**
- Create: `src/renderer/src/components/insights/TokenHeatmap.tsx`

- [ ] **Step 1: 创建 TokenHeatmap.tsx**

从旧 `InsightsPage.tsx` 中提取 Heatmap 和 HeatmapTooltip，使用 `shared.ts` 的类型:

```tsx
import { useState, useMemo, useCallback } from 'react'
import type { HeatmapCell } from './shared'
import { formatTokenCount } from './shared'

const HEATMAP_LEVELS = [
  'bg-surface',
  'bg-soft-green/20',
  'bg-soft-green/40',
  'bg-soft-green/60',
  'bg-soft-green',
]

function HeatmapTooltip({ date, value, x, y }: { date: string; value: number; x: number; y: number }) {
  return (
    <div
      className="fixed z-50 px-2 py-1 rounded bg-hover border border-edge text-xs text-primary shadow-lg pointer-events-none"
      style={{ left: x, top: y - 36 }}
    >
      {date} · {formatTokenCount(value)} tokens
    </div>
  )
}

export function TokenHeatmap({ data }: { data: HeatmapCell[] }) {
  const [tooltip, setTooltip] = useState<{ date: string; value: number; x: number; y: number } | null>(null)

  const grid = useMemo(() => {
    const map = new Map(data.map((d) => [d.date, d]))
    const today = new Date()
    const rows: Array<Array<HeatmapCell & { key: string }>> = Array.from({ length: 7 }, () => [])

    const start = new Date(today)
    start.setDate(start.getDate() - 364)
    const startDow = start.getDay()
    if (startDow !== 0) {
      start.setDate(start.getDate() - startDow)
    }

    const cursor = new Date(start)
    while (cursor <= today) {
      const iso = cursor.toISOString().slice(0, 10)
      const dow = cursor.getDay()
      const cell = map.get(iso) || { date: iso, value: 0, level: 0 as const }
      rows[dow].push({ ...cell, key: iso })
      cursor.setDate(cursor.getDate() + 1)
    }

    return rows
  }, [data])

  const months = useMemo(() => {
    if (grid[0].length === 0) return []
    const labels: Array<{ label: string; col: number }> = []
    let lastMonth = -1
    for (let col = 0; col < grid[0].length; col++) {
      const d = new Date(grid[0][col].key)
      const m = d.getMonth()
      if (m !== lastMonth) {
        labels.push({
          label: d.toLocaleString('default', { month: 'short' }),
          col,
        })
        lastMonth = m
      }
    }
    return labels
  }, [grid])

  const colCount = grid[0]?.length || 0

  const handleMouseEnter = useCallback((e: React.MouseEvent, cell: HeatmapCell) => {
    const rect = (e.target as HTMLElement).getBoundingClientRect()
    setTooltip({ date: cell.date, value: cell.value, x: rect.left + rect.width / 2, y: rect.top })
  }, [])

  const handleMouseLeave = useCallback(() => setTooltip(null), [])

  return (
    <div className="space-y-1">
      <div className="relative" style={{ paddingTop: 16 }}>
        <div className="flex gap-[2px]" style={{ position: 'absolute', top: 0, left: 0 }}>
          {months.map((m, i) => (
            <span
              key={i}
              className="text-[10px] text-muted"
              style={{ position: 'absolute', left: m.col * 12 }}
            >
              {m.label}
            </span>
          ))}
        </div>
        <div
          className="grid gap-[2px]"
          style={{
            gridTemplateRows: 'repeat(7, 10px)',
            gridTemplateColumns: `repeat(${colCount}, 10px)`,
            gridAutoFlow: 'column',
          }}
        >
          {grid.flatMap((row) =>
            row.map((cell) => (
              <div
                key={cell.key}
                className={`w-[10px] h-[10px] rounded-[2px] ${HEATMAP_LEVELS[cell.level]}`}
                onMouseEnter={(e) => handleMouseEnter(e, cell)}
                onMouseLeave={handleMouseLeave}
              />
            ))
          )}
        </div>
      </div>
      {tooltip && <HeatmapTooltip {...tooltip} />}
    </div>
  )
}
```

- [ ] **Step 2: Commit**

```bash
git add src/renderer/src/components/insights/TokenHeatmap.tsx
git commit -m "feat: 迁移热力图组件到 insights/TokenHeatmap"
```

---

### Task 7: UI — 创建统计卡片组件 (StatsCards)

**Files:**
- Create: `src/renderer/src/components/insights/StatsCards.tsx`

- [ ] **Step 1: 创建 StatsCards.tsx**

```tsx
import type { InsightsData } from './shared'
import { formatTokenCount, formatDuration } from './shared'

export function StatsCards({ data }: { data: InsightsData }) {
  const activeDays = data.activeDays
  const dailyAvgTime = activeDays > 0 ? Math.round(data.totalTime / activeDays) : 0

  const cards = [
    {
      value: formatTokenCount(data.totalTokens),
      label: 'Total Tokens',
      sub: `${formatTokenCount(data.totalInputTokens)} in / ${formatTokenCount(data.totalOutputTokens)} out`,
    },
    {
      value: String(data.totalSessions),
      label: 'Sessions',
      sub: '',
    },
    {
      value: formatTokenCount(data.totalTurns),
      label: 'Total Turns',
      sub: '',
    },
    {
      value: String(activeDays),
      label: 'Active Days',
      sub: '',
    },
    {
      value: formatDuration(data.totalTime),
      label: 'Est. Time',
      sub: dailyAvgTime > 0 ? `${formatDuration(dailyAvgTime)}/day` : '',
    },
  ]

  return (
    <div className="grid grid-cols-5 gap-3">
      {cards.map((c) => (
        <div key={c.label} className="bg-surface rounded-lg p-4 border border-edge">
          <div className="text-lg font-medium text-primary">{c.value}</div>
          <div className="text-xs text-muted">{c.label}</div>
          {c.sub && <div className="text-[11px] text-muted mt-0.5">{c.sub}</div>}
        </div>
      ))}
    </div>
  )
}
```

- [ ] **Step 2: Commit**

```bash
git add src/renderer/src/components/insights/StatsCards.tsx
git commit -m "feat: 新增 5 统计卡片组件"
```

---

### Task 8: UI — 创建来源环形图 (SourceDonut)

**Files:**
- Create: `src/renderer/src/components/insights/SourceDonut.tsx`

- [ ] **Step 1: 创建 SourceDonut.tsx**

```tsx
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip } from 'recharts'
import type { BySource } from './shared'
import { formatTokenCount, SOURCE_COLORS } from './shared'

interface PayloadItem {
  name: string
  value: number
  source: string
}

function CustomTooltip({ active, payload }: { active?: boolean; payload?: Array<{ payload: PayloadItem }> }) {
  if (!active || !payload?.[0]) return null
  const d = payload[0].payload
  return (
    <div className="px-2 py-1 rounded bg-hover border border-edge text-xs text-primary shadow-lg">
      {d.name}: {formatTokenCount(d.value)}
    </div>
  )
}

export function SourceDonut({ sources }: { sources: BySource[] }) {
  const total = sources.reduce((s, b) => s + b.totalTokens, 0)
  if (total === 0) return null

  const data = sources.map((s) => ({
    name: s.label,
    value: s.totalTokens,
    source: s.source,
  }))

  return (
    <div className="flex items-center gap-4">
      <div className="relative" style={{ width: 160, height: 160 }}>
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={data}
              cx="50%"
              cy="50%"
              innerRadius={50}
              outerRadius={75}
              dataKey="value"
              stroke="none"
            >
              {data.map((entry) => (
                <Cell key={entry.source} fill={SOURCE_COLORS[entry.source] || '#71717a'} />
              ))}
            </Pie>
            <Tooltip content={<CustomTooltip />} />
          </PieChart>
        </ResponsiveContainer>
        <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
          <span className="text-lg font-medium text-primary">{formatTokenCount(total)}</span>
          <span className="text-[10px] text-muted">tokens</span>
        </div>
      </div>
      <div className="flex flex-col gap-1.5">
        {sources.map((s) => {
          const pct = total > 0 ? ((s.totalTokens / total) * 100).toFixed(1) : '0'
          return (
            <div key={s.source} className="flex items-center gap-1.5">
              <div className="w-2.5 h-2.5 rounded-sm shrink-0" style={{ backgroundColor: SOURCE_COLORS[s.source] || '#71717a' }} />
              <span className="text-xs text-primary">{s.label}</span>
              <span className="text-xs text-muted">{formatTokenCount(s.totalTokens)} ({pct}%)</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Commit**

```bash
git add src/renderer/src/components/insights/SourceDonut.tsx
git commit -m "feat: 新增来源环形图组件（Recharts PieChart）"
```

---

### Task 9: UI — 创建项目排行组件 (ProjectRanking)

**Files:**
- Create: `src/renderer/src/components/insights/ProjectRanking.tsx`

- [ ] **Step 1: 创建 ProjectRanking.tsx**

```tsx
import type { ByProject, ByFolder } from './shared'
import { formatTokenCount, PROJECT_COLORS } from './shared'

export function ProjectRanking({ projects }: { projects: ByProject[] | ByFolder[] }) {
  const top = projects.slice(0, 10)
  const maxTokens = top[0]?.totalTokens || 1

  return (
    <div className="space-y-1">
      {top.map((p, i) => {
        const pct = (p.totalTokens / maxTokens) * 100
        const name = 'project' in p ? p.project : p.folderName
        const key = 'project' in p ? p.fullPath : p.folderId
        const color = PROJECT_COLORS[i % PROJECT_COLORS.length]
        return (
          <div key={key} className="flex items-center gap-2" style={{ height: 28 }}>
            <span className="text-xs text-secondary truncate w-32 shrink-0" title={key}>
              {name}
            </span>
            <div className="flex-1 h-4 bg-surface rounded overflow-hidden">
              <div
                className="h-full rounded transition-all"
                style={{ width: `${pct}%`, backgroundColor: color }}
              />
            </div>
            <span className="text-xs text-muted w-14 text-right shrink-0">
              {formatTokenCount(p.totalTokens)}
            </span>
          </div>
        )
      })}
    </div>
  )
}
```

- [ ] **Step 2: Commit**

```bash
git add src/renderer/src/components/insights/ProjectRanking.tsx
git commit -m "feat: 新增项目排行组件（支持项目/文件夹两种模式）"
```

---

### Task 10: UI — 创建每日趋势组件 (DailyTrend)

**Files:**
- Create: `src/renderer/src/components/insights/DailyTrend.tsx`

- [ ] **Step 1: 创建 DailyTrend.tsx（用 Recharts 重写）**

```tsx
import { useMemo } from 'react'
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts'
import type { ByDate } from './shared'
import { formatTokenCount } from './shared'

interface CustomTooltipProps {
  active?: boolean
  payload?: Array<{ value: number; dataKey: string }>
  label?: string
}

function CustomTooltip({ active, payload, label }: CustomTooltipProps) {
  if (!active || !payload || payload.length === 0) return null
  return (
    <div className="px-2 py-1 rounded bg-hover border border-edge text-xs text-primary shadow-lg space-y-0.5">
      <div>{label}</div>
      {payload.map((p) => (
        <div key={p.dataKey}>
          {p.dataKey === 'inputTokens' ? 'Input' : 'Output'}: {formatTokenCount(p.value)}
        </div>
      ))}
    </div>
  )
}

export function DailyTrend({ data }: { data: ByDate[] }) {
  const last30 = useMemo(() => data.slice(-30), [data])

  const chartData = useMemo(() =>
    last30.map((d) => ({
      date: d.date.slice(5),
      inputTokens: d.inputTokens,
      outputTokens: d.outputTokens,
    })),
    [last30]
  )

  if (chartData.length === 0) return null

  return (
    <div className="space-y-2">
      <ResponsiveContainer width="100%" height={180}>
        <AreaChart data={chartData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
          <XAxis
            dataKey="date"
            tick={{ fontSize: 9, fill: 'var(--color-muted)' }}
            axisLine={{ stroke: 'var(--color-edge)' }}
            tickLine={false}
            interval="preserveStartEnd"
          />
          <YAxis
            tick={{ fontSize: 9, fill: 'var(--color-muted)' }}
            axisLine={false}
            tickLine={false}
            tickFormatter={formatTokenCount}
            width={40}
          />
          <Tooltip content={<CustomTooltip />} />
          <Area type="monotone" dataKey="inputTokens" stackId="1" stroke="#3b82f6" fill="#3b82f6" fillOpacity={0.25} />
          <Area type="monotone" dataKey="outputTokens" stackId="1" stroke="#f59e0b" fill="#f59e0b" fillOpacity={0.25} />
        </AreaChart>
      </ResponsiveContainer>
      <div className="flex gap-3">
        <div className="flex items-center gap-1.5">
          <div className="w-2.5 h-2.5 rounded-sm" style={{ backgroundColor: '#3b82f6' }} />
          <span className="text-xs text-muted">Input</span>
        </div>
        <div className="flex items-center gap-1.5">
          <div className="w-2.5 h-2.5 rounded-sm" style={{ backgroundColor: '#f59e0b' }} />
          <span className="text-xs text-muted">Output</span>
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Commit**

```bash
git add src/renderer/src/components/insights/DailyTrend.tsx
git commit -m "feat: 新增每日趋势组件（Recharts AreaChart）"
```

---

### Task 11: UI — 创建每日洞察时间轴 (DailyTimeline)

**Files:**
- Create: `src/renderer/src/components/insights/DailyTimeline.tsx`

- [ ] **Step 1: 创建 DailyTimeline.tsx**

```tsx
import { useState, useMemo } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import type { ByDate } from './shared'
import { formatTokenCount, formatDuration, PROJECT_COLORS } from './shared'

interface DailyTimelineProps {
  data: ByDate[]
  projectKey: 'byProject' | 'byFolder'
}

export function DailyTimeline({ data, projectKey }: DailyTimelineProps) {
  const [visibleDays, setVisibleDays] = useState(14)
  const [expandedDate, setExpandedDate] = useState<string | null>(null)

  const recentDays = useMemo(() => {
    return data
      .filter(d => d.totalTokens > 0)
      .slice(-visibleDays)
      .reverse()
  }, [data, visibleDays])

  const allProjectNames = useMemo(() => {
    const names = new Set<string>()
    for (const d of recentDays) {
      for (const key of Object.keys(projectKey === 'byProject' ? d.byProject : d.byProjectTime)) {
        names.add(key)
      }
    }
    const colorMap = new Map<string, string>()
    let i = 0
    for (const name of names) {
      colorMap.set(name, PROJECT_COLORS[i % PROJECT_COLORS.length])
      i++
    }
    return colorMap
  }, [recentDays, projectKey])

  function formatDayHeader(dateStr: string): string {
    const d = new Date(dateStr)
    const weekdays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
    return `${d.getMonth() + 1}/${d.getDate()} (${weekdays[d.getDay()]})`
  }

  return (
    <div className="space-y-2">
      {recentDays.map((day) => {
        const isExpanded = expandedDate === day.date
        const tokenMap = projectKey === 'byProject' ? day.byProject : {}
        const timeMap = day.byProjectTime
        const projects = Object.entries(tokenMap).sort((a, b) => b[1] - a[1])
        const maxTokens = projects[0]?.[1] || 1

        return (
          <div key={day.date} className="bg-surface rounded-lg border border-edge">
            <button
              onClick={() => setExpandedDate(isExpanded ? null : day.date)}
              className="w-full px-3 py-2 flex items-center gap-2 hover:bg-hover rounded-lg transition-colors"
            >
              {isExpanded ? <ChevronDown size={12} className="text-muted shrink-0" /> : <ChevronRight size={12} className="text-muted shrink-0" />}
              <span className="text-xs text-primary font-medium">{formatDayHeader(day.date)}</span>
              <span className="text-[11px] text-muted">{formatDuration(day.totalTime)}</span>
              <span className="text-[11px] text-muted">·</span>
              <span className="text-[11px] text-muted">{formatTokenCount(day.totalTokens)}</span>
            </button>

            {projects.length > 0 && !isExpanded && (
              <div className="px-3 pb-2 pl-7">
                <div className="flex h-3 rounded overflow-hidden gap-[1px]">
                  {projects.map(([name, tokens]) => {
                    const pct = (tokens / maxTokens) * 100
                    return (
                      <div
                        key={name}
                        className="rounded-sm transition-all"
                        style={{ width: `${pct}%`, backgroundColor: allProjectNames.get(name) || '#71717a', minWidth: 2 }}
                        title={`${name}: ${formatTokenCount(tokens)}`}
                      />
                    )
                  })}
                </div>
                <div className="flex flex-wrap gap-2 mt-1">
                  {projects.map(([name, tokens]) => (
                    <span key={name} className="flex items-center gap-1">
                      <span className="w-1.5 h-1.5 rounded-sm shrink-0" style={{ backgroundColor: allProjectNames.get(name) || '#71717a' }} />
                      <span className="text-[10px] text-muted">{name}</span>
                    </span>
                  ))}
                </div>
              </div>
            )}

            {isExpanded && (
              <div className="px-3 pb-2 pl-7 space-y-1">
                {projects.map(([name, tokens]) => {
                  const pct = (tokens / maxTokens) * 100
                  const time = timeMap[name] || 0
                  return (
                    <div key={name} className="flex items-center gap-2" style={{ height: 24 }}>
                      <span className="w-1.5 h-1.5 rounded-sm shrink-0" style={{ backgroundColor: allProjectNames.get(name) || '#71717a' }} />
                      <span className="text-xs text-secondary truncate w-28 shrink-0">{name}</span>
                      <div className="flex-1 h-3 rounded overflow-hidden bg-hover">
                        <div
                          className="h-full rounded transition-all"
                          style={{ width: `${pct}%`, backgroundColor: allProjectNames.get(name) || '#71717a' }}
                        />
                      </div>
                      <span className="text-[11px] text-muted w-20 text-right shrink-0">
                        {formatDuration(time)} · {formatTokenCount(tokens)}
                      </span>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        )
      })}

      {visibleDays < data.filter(d => d.totalTokens > 0).length && (
        <button
          onClick={() => setVisibleDays(d => d + 14)}
          className="w-full py-2 text-xs text-muted hover:text-primary hover:bg-surface rounded-lg transition-colors"
        >
          加载更多
        </button>
      )}
    </div>
  )
}
```

- [ ] **Step 2: Commit**

```bash
git add src/renderer/src/components/insights/DailyTimeline.tsx
git commit -m "feat: 新增每日洞察时间轴组件"
```

---

### Task 12: UI — 组装 InsightsPage 主页面

**Files:**
- Create: `src/renderer/src/components/insights/InsightsPage.tsx`
- Modify: `src/renderer/src/components/InsightsPage.tsx` (删除旧文件)
- Modify: `src/renderer/src/App.tsx` (更新 import)

- [ ] **Step 1: 创建新的 InsightsPage.tsx**

```tsx
import { useState, useEffect, useMemo } from 'react'
import { useStore } from '../../store'
import { StatsCards } from './StatsCards'
import { TokenHeatmap } from './TokenHeatmap'
import { SourceDonut } from './SourceDonut'
import { ProjectRanking } from './ProjectRanking'
import { DailyTrend } from './DailyTrend'
import { DailyTimeline } from './DailyTimeline'
import type { InsightsData } from './shared'

export function InsightsPage() {
  const api = (window as any).api
  const config = useStore((s) => s.config)
  const [data, setData] = useState<InsightsData | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    api.getInsights().then((d: InsightsData) => {
      if (!cancelled) {
        setData(d)
        setLoading(false)
      }
    })
    return () => { cancelled = true }
  }, [])

  const projectViewMode = config?.preferences?.projectViewMode || 'folders'

  const projectData = useMemo(() => {
    if (!data) return []
    return projectViewMode === 'paths' ? data.byProject : data.byFolder
  }, [data, projectViewMode])

  if (loading || !data) {
    return (
      <div className="flex-1 flex items-center justify-center text-muted text-sm">
        Loading...
      </div>
    )
  }

  return (
    <div className="flex-1 overflow-y-auto p-4 space-y-4">
      <StatsCards data={data} />

      <div className="grid grid-cols-2 gap-4">
        <div className="bg-surface rounded-lg p-4 border border-edge space-y-2">
          <div className="text-sm font-medium text-primary">Token Heatmap</div>
          <div className="overflow-x-auto">
            <TokenHeatmap data={data.heatmap} />
          </div>
        </div>
        <div className="bg-surface rounded-lg p-4 border border-edge space-y-2">
          <div className="text-sm font-medium text-primary">By Source</div>
          <SourceDonut sources={data.bySource} />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="bg-surface rounded-lg p-4 border border-edge space-y-2">
          <div className="text-sm font-medium text-primary">Top Projects</div>
          <ProjectRanking projects={projectData} />
        </div>
        <div className="bg-surface rounded-lg p-4 border border-edge space-y-2">
          <div className="text-sm font-medium text-primary">Daily Trend (30d)</div>
          <DailyTrend data={data.byDate} />
        </div>
      </div>

      <div className="bg-surface rounded-lg p-4 border border-edge space-y-2">
        <div className="text-sm font-medium text-primary">Daily Insights</div>
        <DailyTimeline data={data.byDate} projectKey={projectViewMode === 'paths' ? 'byProject' : 'byProject'} />
      </div>
    </div>
  )
}
```

- [ ] **Step 2: 更新 App.tsx 的 import**

在 `src/renderer/src/App.tsx` 中，将:
```typescript
import { InsightsPage } from './components/InsightsPage'
```
改为:
```typescript
import { InsightsPage } from './components/insights/InsightsPage'
```

- [ ] **Step 3: 删除旧的 InsightsPage.tsx**

Run: `rm src/renderer/src/components/InsightsPage.tsx`

- [ ] **Step 4: 编译验证**

Run: `npx electron-vite build`
Expected: 编译通过（可能有 CSS 变量在 Recharts 中的兼容性问题需要调整）

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/components/insights/InsightsPage.tsx src/renderer/src/App.tsx
git rm src/renderer/src/components/InsightsPage.tsx
git commit -m "feat: 仪表盘网格布局 Insights 页面上线"
```

---

### Task 13: Settings — 新增项目视图切换设置

**Files:**
- Modify: `src/renderer/src/components/SettingsPanel.tsx`
- Modify: `src/renderer/src/i18n.ts`

- [ ] **Step 1: 在 i18n.ts 新增翻译 key**

在 `zh-CN` 的 settings 区域新增:
```typescript
'settings.project_view': '项目视图',
'settings.project_view_folders': '按整理的文件夹',
'settings.project_view_paths': '按实际项目路径',
```

在 `en` 的 settings 区域新增:
```typescript
'settings.project_view': 'Project View',
'settings.project_view_folders': 'By organized folders',
'settings.project_view_paths': 'By actual project paths',
```

- [ ] **Step 2: 在 SettingsPanel.tsx 新增项目视图切换**

在 SSH section 之后新增 section:

```tsx
{/* Project View */}
<section>
  <label className="flex items-center gap-2 text-xs font-medium text-secondary mb-2">
    <FolderTree size={12} />
    {t('settings.project_view')}
  </label>
  <div className="flex gap-1">
    {([['folders', t('settings.project_view_folders')], ['paths', t('settings.project_view_paths')]] as const).map(([mode, label]) => (
      <button
        key={mode}
        onClick={() => savePreferences({ projectViewMode: mode })}
        className={`flex-1 px-2 py-1.5 rounded-md text-xs transition-colors ${
          (config?.preferences?.projectViewMode || 'folders') === mode
            ? 'bg-accent/15 text-accent'
            : 'bg-surface text-muted hover:text-primary hover:bg-hover'
        }`}
      >
        {label}
      </button>
    ))}
  </div>
</section>
```

注意: 需要在 SettingsPanel 的导入中添加 `FolderTree`:
```typescript
import { X, Sun, Moon, Monitor, Globe, Keyboard, Server, FolderTree } from 'lucide-react'
```

- [ ] **Step 3: 运行测试**

Run: `npm test`
Expected: 所有测试通过

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/components/SettingsPanel.tsx src/renderer/src/i18n.ts
git commit -m "feat: 设置页新增项目视图切换"
```

---

### Task 14: Sidebar — paths 模式下自动生成项目树

**Files:**
- Modify: `src/renderer/src/components/Sidebar.tsx`

- [ ] **Step 1: 在 Sidebar.tsx 新增 paths 模式的文件夹树生成**

在 Sidebar 组件中，根据 `config?.preferences?.projectViewMode` 决定展示哪种树。

在 `rootFolders` 的 useMemo 之后新增:

```typescript
const projectViewMode = config?.preferences?.projectViewMode || 'folders'

// paths 模式: 从 sessions 的 cwd 自动生成虚拟文件夹树
const pathFolders = useMemo(() => {
  if (projectViewMode !== 'paths') return []
  const cwdMap = new Map<string, string[]>() // projectName → sessionIds
  for (const s of sessions) {
    const cwd = s.cwds?.[0] || ''
    const parts = cwd.split('/')
    const projectName = parts[parts.length - 1] || cwd
    if (!cwdMap.has(projectName)) cwdMap.set(projectName, [])
    cwdMap.get(projectName)!.push(s.id)
  }
  return Array.from(cwdMap.entries()).map(([name, sessionIds], i) => ({
    id: `path-${i}`,
    name,
    parentId: null as string | null,
    sessionIds,
    createdAt: '',
  }))
}, [sessions, projectViewMode])

const effectiveRootFolders = projectViewMode === 'paths' ? pathFolders : rootFolders
const effectiveAllFolders = projectViewMode === 'paths' ? pathFolders : (config?.folders || [])
```

然后将 Sidebar 渲染中的 `rootFolders` 替换为 `effectiveRootFolders`，`config?.folders || []` 替换为 `effectiveAllFolders`。

在 paths 模式下隐藏拖拽、右键文件夹操作（新建子文件夹、删除、重命名），只保留展开/折叠和 session 点击。

- [ ] **Step 2: 调整 FolderNode 在 paths 模式下的渲染**

在 FolderNode 中根据传入的 `allFolders` 是否有 `path-` 前缀 id 来决定是否显示操作按钮。或者在 Sidebar 中传入一个 `isPathMode` prop 来控制。

最简方案: 在 paths 模式下不渲染 `creatingSubfolderId`、`renamingFolderId` 相关的按钮，`handleDrop` 中的 folder 操作跳过。

- [ ] **Step 3: 在 paths 模式下隐藏"新建文件夹"按钮**

在 Sidebar 顶部的按钮区:
```tsx
{projectViewMode === 'folders' && (
  <button onClick={() => setShowNewFolder(true)}
    className="p-1 hover:bg-hover rounded text-secondary hover:text-primary" title={t('sidebar.new_folder')}>
    <FolderPlus size={14} />
  </button>
)}
```

- [ ] **Step 4: 编译验证**

Run: `npx electron-vite build`
Expected: 编译通过

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/components/Sidebar.tsx
git commit -m "feat: Sidebar 支持 paths 模式自动生成项目树"
```

---

### Task 15: 集成验证和修复

**Files:**
- 可能修改上述任何文件

- [ ] **Step 1: 运行完整测试**

Run: `npm test`
Expected: 所有 152+ 测试通过

- [ ] **Step 2: 编译验证**

Run: `npx electron-vite build`
Expected: 编译通过

- [ ] **Step 3: Dev 模式启动验证**

Run: `npm run dev`
Expected: 应用启动，点击 Insights 按钮可以看到新布局

- [ ] **Step 4: 最终 Commit**

如果需要修复:
```bash
git add -A
git commit -m "fix: Insights 集成验证修复"
```
