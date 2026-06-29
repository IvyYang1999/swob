# Agentic Desktop — 设计文档

> 日期：2026-04-27
> 状态：已确认，待实施

## 背景与动机

Swob 当前是一个传统 Electron 应用：能力、逻辑、UI 三者编译在一起，耦合紧密。随着 AI Agent 的发展，软件形态正在从"固定功能 + 固定界面"转向"Agent 动态组合原子能力 + 按需渲染 UI"。

目标：
1. 将 Swob 改造为 Agent 原生架构
2. 边做边抽象出通用框架，最终成为"AI 时代的 Electron"
3. 能力包（npm package）可被其他开发者复用

## 核心理念

- **能力即函数**：每个功能是带 schema 的纯函数，不依赖 Electron、不依赖 UI
- **协议无关**：能力层不绑定 MCP/AG-UI 等任何协议，协议只是适配器
- **UI 是皮肤**：当前界面只是能力的一种渲染方式，Agent 可以驱动出完全不同的交互
- **渐进式**：新仓库，不影响现有 Swob，逐步迁移

## 架构总览

三层分离：

```
┌─────────────────────────────────┐
│  Swob App                       │  第一个产品
│  注册组件 + 注册能力 + 定义布局   │
├─────────────────────────────────┤
│  @swob/agentic-ui               │  Agentic UI 框架
│  UI 引擎 + Agent 运行时 + 适配器 │
├─────────────────────────────────┤
│  @swob/capabilities             │  原子能力包
│  session-reader / folder / ...  │
└─────────────────────────────────┘
```

## 第一层：能力包 (@swob/capabilities)

### Capability 接口

```typescript
interface Capability<I, O> {
  name: string              // 命名空间.能力名，如 "session.search"
  description: string       // Agent 靠这个理解什么时候该调用
  inputSchema: JSONSchema   // 输入参数描述
  outputSchema: JSONSchema  // 输出描述
  execute(input: I): Promise<O>  // 纯函数，不依赖 Electron 和 UI
}
```

### Registry

所有能力注册到一个中心 Registry：

```typescript
class CapabilityRegistry {
  register<I, O>(capability: Capability<I, O>): void
  get(name: string): Capability<unknown, unknown>
  list(): CapabilityMetadata[]    // 返回所有能力的 name + schema
  execute(name: string, input: unknown): Promise<unknown>
}
```

Registry 是唯一的真相来源。UI、内置 Agent、外部协议都通过 Registry 访问能力。

### Swob 能力清单

| 能力名 | 来源 | 说明 |
|--------|------|------|
| `session.list` | session-loader.ts | 列出所有 session，支持按文件夹/状态筛选 |
| `session.read` | session-loader.ts | 读取单个 session 的完整消息 |
| `session.search` | 搜索逻辑 | 全文搜索，支持 regex |
| `session.export` | 导出逻辑 | 导出为 markdown / json |
| `folder.list` | library-manager.ts | 文件夹树结构 |
| `folder.create` | library-manager.ts | 创建文件夹 |
| `folder.move` | library-manager.ts | 移动 session 到文件夹 |
| `folder.rename` | library-manager.ts | 重命名文件夹 |
| `folder.delete` | library-manager.ts | 删除文件夹 |
| `process.detect` | 进程检测 | 检测活跃的 Claude Code 进程 |
| `resume.execute` | resume 逻辑 | 在终端恢复 session |

### 能力的纯函数要求

- 不调用 Electron API（文件操作用 Node.js fs）
- 不依赖 React 状态
- 不直接操作 DOM
- 输入相同 → 输出相同（幂等）
- 需要 Electron 能力时（如打开终端窗口），通过 execute 中的副作用声明

## 第二层：Agentic UI 框架 (@swob/agentic-ui)

### UI 渲染引擎

Agent 不写 React 代码，而是发出 UI 描述，引擎负责渲染：

```typescript
interface UIDescription {
  layout: string              // 布局方式：split / single / custom
  regions: {
    [regionName: string]: {
      component: string       // 注册的组件名
      data: unknown           // capability 返回的数据
      actions: string[]       // 该区域支持的操作列表
    }
  }
}
```

### 组件注册

应用层向引擎注册具体组件：

```typescript
uiEngine.registerComponent("tree", TreeComponent)
uiEngine.registerComponent("chat-viewer", ChatViewerComponent)
```

引擎维护一个组件注册表。收到 UI 描述后，按 component 名查找并渲染。

### 操作绑定

UI 描述中的 actions 绑定到 capability：

```typescript
// 用户点击 action → 引擎查找对应 capability → 执行 → 更新 UI
uiEngine.bindAction("export", "session.export")
```

### Agent Host

内置 Agent 运行时，支持：
- 接收用户自然语言输入
- 调用 Registry 中的能力
- 生成 UI 描述驱动渲染
- 执行 Skill 定义的组合工作流

LLM 选择灵活，初期可用 OpenAI / Anthropic API，后续支持本地模型。

### Skill 层

Skill 是多个 capability 的组合编排，带上下文知识：

```typescript
interface Skill {
  name: string                // "organize-sessions"
  description: string         // "整理所有未归类的 session"
  trigger: string             // 触发条件描述
  capabilities: string[]      // 依赖的能力列表
  workflow: string            // Agent 执行步骤的描述
  examples: SkillExample[]    // 示例输入输出
}
```

### 协议适配器

能力层协议无关，适配器桥接到外部协议：

| 适配器 | 用途 |
|--------|------|
| Direct API | 内部调用，无序列化开销 |
| MCP Adapter | 外部 Agent（Claude Code 等）通过 MCP 调用 |
| AG-UI Adapter | 支持 AG-UI 协议的 Agent 通信 |
| 未来适配器 | 新协议出现时加一个 adapter 即可 |

```
                 ┌──────────────┐
                 │   Registry   │
                 └──────┬───────┘
          ┌─────────────┼─────────────┐
          │             │             │
     ┌────▼───┐   ┌────▼────┐   ┌───▼──────┐
     │  MCP   │   │  AG-UI  │   │  Direct  │
     │Adapter │   │ Adapter │   │   API    │
     └────────┘   └─────────┘   └──────────┘
```

### 三种驱动模式

| 模式 | 驱动者 | 场景 |
|------|--------|------|
| 预定义布局 | 启动时加载固定布局描述 | 现有 Swob 的使用方式，看起来一样 |
| 内置 Agent | Swob 内置 LLM | 用户用自然语言操作 Swob |
| 外部 Agent | Claude Code 等通过协议调用 | Agent 在外部编排，Swob 是能力提供者 |

三种模式共用同一套 capability。

## 第三层：Swob App

### 职责

Swob App 只做三件事：
1. 注册 Swob 专属组件到 UI 引擎
2. 注册 Swob 专属能力到 Registry
3. 定义默认布局

```typescript
// registrations.ts
import { capabilityRegistry, uiEngine } from "@swob/agentic-ui"

// 注册能力
capabilityRegistry.register(sessionListCapability)
capabilityRegistry.register(sessionSearchCapability)
// ...

// 注册组件
uiEngine.registerComponent("tree", SidebarComponent)
uiEngine.registerComponent("chat-viewer", ChatViewerComponent)
// ...

// 定义默认布局
uiEngine.setLayout({
  layout: "split",
  regions: {
    sidebar: { component: "tree", actions: ["create", "move", "rename"] },
    main: { component: "chat-viewer", actions: ["resume", "export"] },
    info: { component: "info-panel", actions: [] }
  }
})
```

### 现有功能映射

| 现有代码 | 新位置 |
|----------|--------|
| session-loader.ts (JSONL 解析) | capabilities/session-reader |
| library-manager.ts (文件夹 CRUD) | capabilities/folder-manager |
| 全文搜索逻辑 | capabilities/searcher |
| 导出 Markdown | capabilities/exporter |
| 进程检测 (active session) | capabilities/process-detector |
| resume 到终端 | capabilities/resumer |
| Sidebar.tsx | Swob App 注册为 "tree" 组件 |
| ChatViewer.tsx | Swob App 注册为 "chat-viewer" 组件 |
| InfoPanel.tsx | Swob App 注册为 "info-panel" 组件 |

## 仓库结构

```
swob-next/
├── packages/
│   ├── capabilities/                    # npm: @swob/capabilities
│   │   ├── src/
│   │   │   ├── types.ts                   Capability 接口定义
│   │   │   ├── registry.ts                能力注册中心
│   │   │   ├── session-reader/            JSONL 解析 + session 加载
│   │   │   ├── folder-manager/            文件夹 CRUD + 树结构
│   │   │   ├── searcher/                  全文搜索
│   │   │   ├── exporter/                  导出能力
│   │   │   ├── process-detector/          活跃进程检测
│   │   │   └── resumer/                   resume 到终端
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   └── agentic-ui/                      # npm: @swob/agentic-ui
│       ├── src/
│       │   ├── ui-engine/                 描述式渲染引擎
│       │   ├── agent-host/                内置 Agent 运行时
│       │   ├── skill-engine/              Skill 组合编排
│       │   └── adapters/                  协议适配器
│       │       ├── mcp/
│       │       ├── ag-ui/
│       │       └── direct/
│       ├── package.json
│       └── tsconfig.json
│
├── apps/
│   └── swob/                            # Swob 应用
│       ├── src/
│       │   ├── main/                      Electron 主进程
│       │   ├── renderer/                  React UI
│       │   │   ├── components/              原有 UI 组件
│       │   │   ├── layouts/                 默认布局定义
│       │   │   └── registrations.ts         注册组件和能力
│       │   └── skills/                    Swob 专属 Skill
│       ├── package.json
│       └── electron.vite.config.ts
│
├── package.json                          workspace 根配置
└── tsconfig.json
```

## 渐进路线

### 阶段 1：能力提取
- 搭建 monorepo 骨架（npm workspaces）
- 搭建 `@swob/capabilities` 包基础（types.ts + registry.ts）
- 从最独立的能力开始提取：session-reader、searcher
- UI 不动，底层调用改走 Registry
- **验证**：能力可独立调用，不依赖 Electron

### 阶段 2：Agentic UI 框架骨架
- 搭建 `@swob/agentic-ui` 包
- 实现 UI Engine（组件注册 + 布局描述驱动渲染）
- 实现 Direct API 适配器（内部直接调用）
- Swob 现有组件注册到引擎
- **验证**：UI 看起来一样，但渲染已由引擎驱动

### 阶段 3：外部协议
- 实现 MCP 适配器
- 外部 Agent（Claude Code）可通过 MCP 调用 Swob 能力
- **验证**：Claude Code 通过 MCP 列出/搜索/导出 session

### 阶段 4：内置 Agent + Skill
- 实现 Agent Host
- 定义 Swob 专属 Skill（整理 session、导出备份等）
- **验证**：用户可直接用自然语言操作 Swob

### 阶段 5：通用化
- 将 agentic-ui 中 Swob 无关的部分提炼为通用框架
- 发布 npm 包
- 编写文档和示例
- **验证**：第三方开发者能 `npm install @swob/agentic-ui` 搭建自己的 Agent App

## 设计决策记录

| 决策 | 选择 | 理由 |
|------|------|------|
| Agent 模型 | 内置 + 外部都要 | 最大灵活性 |
| 能力模型 | Protocol-agnostic | 协议会迭代，能力本身稳定 |
| 仓库策略 | 新仓库 monorepo | 不影响现有 Swob，渐进迁移 |
| 起步方式 | 渐进式，先拆能力 | 风险最低，随时可停 |
| 通用化策略 | 边做边判断 | 避免过度设计，从实际需求出发 |
