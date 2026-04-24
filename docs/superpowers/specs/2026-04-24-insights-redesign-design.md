# Insights 页面重设计 + 文件夹视图切换

> 日期：2026-04-24
> 状态：已确认

## 概述

重做 Insights 洞察页为仪表盘网格布局，新增每日洞察时间轴和时间统计；新增全局"项目视图"设置，允许用户在"用户文件夹"和"实际项目路径"之间切换，影响侧边栏和 Insights 的项目分组。

## 布局：方案 C — 仪表盘网格

```
┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐
│Total │ │Sess. │ │Turns │ │ Days │ │ Time │
└──────┘ └──────┘ └──────┘ └──────┘ └──────┘
┌────────────────┐ ┌────────────────┐
│ 365天热力图     │ │ 来源环形图      │
└────────────────┘ └────────────────┘
┌────────────────┐ ┌────────────────┐
│ 项目排行 Top 10 │ │ 30天趋势折线图  │
└────────────────┘ └────────────────┘
┌────────────────────────────────────┐
│ 每日洞察时间轴（全宽横条图）         │
└────────────────────────────────────┘
```

## 第一段：顶部统计卡片（5 个）

| 卡片 | 主值 | 子指标 |
|------|------|--------|
| Total Tokens | input + output 总量 | 小字分别显示 input / output |
| Sessions | 总 session 数 | 小字显示当前活跃数 |
| Total Turns | 总轮次数 | — |
| Active Days | 有记录的天数 | — |
| Est. Time | 总预估活跃时间 | 小字显示日均时间 |

卡片样式保持 `bg-surface rounded-lg p-4 border border-edge`，每个卡片加一行 `text-[11px] text-muted` 的子指标。

## 第二段：中间双列网格

### 左列

1. **365 天热力图**（保留现有 Heatmap 组件）
   - 微调：鼠标悬浮弹窗增加该日项目 Token 分布明细

2. **项目排行 Top 10**（保留现有 ProjectRanking 组件）
   - 改为支持按当前文件夹视图分组显示
   - 颜色与来源环形图一致

### 右列

1. **来源分布环形图**（新增）
   - 替代现有 SourceBar 横条
   - 使用图表库绘制环形图（donut chart）
   - 中间显示 Total Tokens
   - 图例显示各来源占比和具体数值

2. **30 天趋势折线图**（保留 DailyTrend 组件）
   - 可选：用图表库重写以获得更好的交互（hover tooltip）

### 网格布局

CSS Grid `grid-cols-2 gap-4`，左列热力图与右列环形图等高，左列项目排行与右列趋势图等高。

## 第三段：底部每日洞察时间轴

### 展示形式

全宽区域，倒序（最新在上），每行一天。

```
4/24 (周四)  3h 42m · 1.2M tokens
  ██████████████████████ swob       2h 15m · 850K
  ████████ keykeeper                 1h 20m · 320K

4/23 (周三)  5h 10m · 2.1M tokens
  ████████████████████████████ swob  4h 05m · 1.8M
  ████ nightguard                    1h 05m · 300K
```

### 交互

- 默认显示最近 14 天
- 底部"加载更多"按钮（每次加载 14 天）
- 每行可点击展开，查看该日各 Session 的详细明细（session 标题 + token + 时间）
- 项目颜色与来源环形图/项目排行保持一致的颜色映射

### 数据计算

**时间**：相邻消息间隔累加。
- 遍历 session 中所有消息，按时间排序
- 计算相邻消息的时间差
- 超过 30 分钟的间隔截断为 0（视为用户离开）
- 累加所有有效间隔得到 session 的活跃时间

**项目归属**：按当前 `projectViewMode` 设置决定（见第四段）。

**每日归属**：按消息时间戳的日期归属到对应天（而非 session 的 updatedAt）。

## 第四段：文件夹视图切换

### 设置项

在 SettingsPanel 的"偏好"区域新增"项目视图"选项：

| 值 | 说明 |
|----|------|
| `folders` | 按用户在 Library 中整理的文件夹分组（默认，保持现有行为） |
| `paths` | 按 session 的 cwd 路径自动分组 |

存储在 `config.preferences.projectViewMode`，类型 `'folders' | 'paths'`。

### 影响范围

| 模块 | `folders` 模式 | `paths` 模式 |
|------|---------------|-------------|
| Sidebar | 显示用户手动整理的文件夹树（现有行为） | 从 sessions 的 cwd 自动生成项目树 |
| Insights 项目排行 | 使用 `byFolder` 数据 | 使用 `byProject` 数据 |
| Insights 每日时间轴 | 按文件夹分组项目 | 按 cwd 路径分组项目 |
| Insights 统计卡片 | 基于 `byFolder` 聚合 | 基于 `byProject` 聚合 |

### Sidebar paths 模式

- 从所有 session 的 `cwds` 提取唯一路径
- 按路径层级自动构建树（如 `/Users/x/projects/swob` 和 `/Users/x/projects/keykeeper` → 共享 `projects` 父节点）
- 顶级目录作为根节点，最后一级作为项目名
- 保留现有文件夹的所有功能（拖拽、右键等）只改变数据源

### 切换行为

- 切换时不丢失数据，只是视图切换
- 用户整理的文件夹配置始终保留
- 切换后 Insights 页面自动重新渲染

## 数据层变更

### insights.ts 修改

1. **新增时间计算函数** `estimateActiveTime(messages: ParsedMessage[]): number`
   - 输入：session 的所有消息
   - 输出：活跃时间（毫秒）
   - 算法：相邻消息间隔累加，30 分钟截断

2. **InsightsData 新增字段**
   ```typescript
   totalTime: number                    // 总活跃时间（毫秒）
   byDate: DateStats[] 新增:
     totalTime: number                  // 每日活跃时间
     byProjectTime: Record<string, number>  // 每日每项目活跃时间
   ```

3. **buildInsights 修改**
   - 需要接收 messages 数据（或预先计算好的时间数据）
   - SessionSummary 需要新增 `estimatedTime?: number` 字段

### types.ts 修改

SessionSummary 新增：
```typescript
estimatedTime?: number  // 预估活跃时间（毫秒）
```

### store.ts 修改

- preferences 新增 `projectViewMode: 'folders' | 'paths'`
- Insights 组件读取 `projectViewMode` 决定使用哪个数据维度

## 图表库选择

引入轻量图表库替代部分手写 SVG。候选：

| 库 | 大小 (gzip) | 特点 |
|----|------------|------|
| Recharts | ~40KB | React 原生，声明式 API，支持 Pie/Line/Bar |
| Chart.js + react-chartjs-2 | ~60KB | 功能最全，社区最大 |
| Nivo | ~30-50KB/组件 | 漂亮，基于 d3 |

推荐 **Recharts**：React 原生 API，适合我们需要的三种图表（环形图、折线图、横条图），且 bundle size 合理。

用 Recharts 重写：
- 来源环形图（PieChart + donut）
- 30 天趋势折线图（AreaChart）
- 每日洞察横条图（BarChart + stacked）

保留手写：
- 365 天热力图（自定义需求，图表库不适合）

## 组件拆分

InsightsPage 当前 437 行全在一个文件。拆分为：

```
components/
  insights/
    InsightsPage.tsx         # 主页面，布局编排
    StatsCards.tsx           # 顶部 5 个统计卡片
    TokenHeatmap.tsx         # 365 天热力图（迁移现有）
    SourceDonut.tsx          # 来源环形图（新增）
    ProjectRanking.tsx       # 项目排行（迁移现有）
    DailyTrend.tsx           # 30 天趋势（迁移现有，可重写为 Recharts）
    DailyTimeline.tsx        # 每日洞察时间轴（新增）
```

## 测试策略

1. **insights.test.ts**：新增 `estimateActiveTime` 的单元测试
   - 正常消息序列
   - 超过 30 分钟间隔的截断
   - 单条消息（时间为 0）
   - 空消息数组

2. **组件测试**：各图表组件的渲染测试

3. **E2E**：Insights 页面打开、设置切换的集成测试
