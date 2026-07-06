# Agentic Desktop Phase 3 — MCP 适配器

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现 MCP Server 适配器，将 CapabilityRegistry 中的能力自动暴露为 MCP Tools，外部 Agent 可通过 MCP 协议调用 Swob 的能力。

**Architecture:** 在 @swob/agentic-ui 中新增 adapters/mcp 模块。McpCapabilityServer 读取 CapabilityRegistry，为每个能力自动生成 MCP Tool 定义。当外部 Agent 调用 MCP Tool 时，转发到对应 capability 的 execute。Swob App 的 main 进程以 stdio 方式运行 MCP Server。

**Tech Stack:** @modelcontextprotocol/sdk, TypeScript

---

### Task 1: 安装 MCP SDK 依赖

**Files:** 修改 `packages/agentic-ui/package.json`

- [ ] **Step 1: 添加 @modelcontextprotocol/sdk 依赖**

```bash
cd ~/projects/swob-next/packages/agentic-ui && npm install @modelcontextprotocol/sdk
```

- [ ] **Step 2: Commit**

```bash
cd ~/projects/swob-next && git add package.json package-lock.json && git commit -m "chore: 添加 @modelcontextprotocol/sdk 依赖"
```

---

### Task 2: 实现 McpCapabilityServer

从 CapabilityRegistry 自动生成 MCP Tools 的服务器。

**Files:**
- Create: `packages/agentic-ui/src/adapters/mcp/server.ts`
- Create: `packages/agentic-ui/src/adapters/mcp/server.test.ts`

- [ ] **Step 1: 写失败测试**

```typescript
// packages/agentic-ui/src/adapters/mcp/server.test.ts
import { describe, it, expect } from 'vitest'
import { McpCapabilityServer } from './server'
import type { ICapabilityRegistry } from '../../capability-bridge/bridge'
import type { CapabilityMetadata } from '@swob/capabilities'

function createMockRegistry(caps: Array<{
  name: string
  description: string
  inputSchema: Record<string, unknown>
  execute: (input: unknown) => Promise<unknown>
}>): ICapabilityRegistry {
  return {
    execute: async (name: string, input: unknown) => {
      const cap = caps.find(c => c.name === name)
      if (!cap) throw new Error(`能力不存在: ${name}`)
      return cap.execute(input)
    },
    list: (): CapabilityMetadata[] => caps.map(c => ({
      name: c.name,
      description: c.description,
      inputSchema: c.inputSchema,
      outputSchema: { type: 'object' }
    }))
  }
}

describe('McpCapabilityServer', () => {
  it('从 Registry 生成 MCP Tool 列表', async () => {
    const registry = createMockRegistry([
      {
        name: 'session.parse',
        description: '解析 JSONL 文件',
        inputSchema: {
          type: 'object',
          properties: { filePath: { type: 'string' } },
          required: ['filePath']
        },
        execute: async () => ({ messages: [] })
      }
    ])

    const server = new McpCapabilityServer(registry, { name: 'swob', version: '0.1.0' })
    const tools = await server.listTools()

    expect(tools).toHaveLength(1)
    expect(tools[0].name).toBe('session.parse')
    expect(tools[0].description).toBe('解析 JSONL 文件')
  })

  it('调用 MCP Tool 时转发到 capability execute', async () => {
    const registry = createMockRegistry([
      {
        name: 'session.parse',
        description: '解析 JSONL 文件',
        inputSchema: { type: 'object', properties: { filePath: { type: 'string' } } },
        execute: async (input: unknown) => ({ messages: [`parsed: ${(input as { filePath: string }).filePath}`] })
      }
    ])

    const server = new McpCapabilityServer(registry, { name: 'swob', version: '0.1.0' })
    const result = await server.callTool('session.parse', { filePath: '/test.jsonl' })

    expect(result).toEqual({ messages: ['parsed: /test.jsonl'] })
  })

  it('调用不存在的 Tool 抛出错误', async () => {
    const registry = createMockRegistry([])
    const server = new McpCapabilityServer(registry, { name: 'swob', version: '0.1.0' })

    await expect(server.callTool('nonexistent', {})).rejects.toThrow()
  })

  it('空 Registry 返回空 Tool 列表', async () => {
    const registry = createMockRegistry([])
    const server = new McpCapabilityServer(registry, { name: 'swob', version: '0.1.0' })

    const tools = await server.listTools()
    expect(tools).toHaveLength(0)
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

```bash
cd ~/projects/swob-next/packages/agentic-ui && npx vitest run src/adapters/mcp/server.test.ts
```

- [ ] **Step 3: 实现 server.ts**

```typescript
// packages/agentic-ui/src/adapters/mcp/server.ts
import type { ICapabilityRegistry } from '../../capability-bridge/bridge'
import type { CapabilityMetadata } from '@swob/capabilities'

export interface McpServerInfo {
  name: string
  version: string
}

export interface McpTool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

export class McpCapabilityServer {
  private capabilities: CapabilityMetadata[]

  constructor(
    private registry: ICapabilityRegistry,
    private serverInfo: McpServerInfo
  ) {
    this.capabilities = registry.list()
  }

  async listTools(): Promise<McpTool[]> {
    return this.capabilities.map((cap) => ({
      name: cap.name,
      description: cap.description,
      inputSchema: cap.inputSchema as Record<string, unknown>
    }))
  }

  async callTool(name: string, args: unknown): Promise<unknown> {
    return this.registry.execute(name, args)
  }

  getServerInfo(): McpServerInfo {
    return this.serverInfo
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

```bash
cd ~/projects/swob-next/packages/agentic-ui && npx vitest run src/adapters/mcp/server.test.ts
```

- [ ] **Step 5: 更新 index.ts 导出**

```typescript
// 在 packages/agentic-ui/src/index.ts 末尾添加
export { McpCapabilityServer } from './adapters/mcp/server'
export type { McpServerInfo, McpTool } from './adapters/mcp/server'
```

- [ ] **Step 6: Commit**

```bash
cd ~/projects/swob-next && git add -A && git commit -m "feat: 实现 McpCapabilityServer（Registry → MCP Tool 自动映射）"
```

---

### Task 3: 实现 stdio 传输的 MCP Server 启动器

一个可执行的入口脚本，Swob 的 main 进程或外部 Agent 可以通过 stdio 与之通信。

**Files:**
- Create: `apps/swob/src/main/mcp-server.ts`

- [ ] **Step 1: 创建 MCP Server 启动脚本**

```typescript
// apps/swob/src/main/mcp-server.ts
// 独立入口：通过 stdio 暴露 Swob 能力为 MCP Tools
// 用法：node out/main/mcp-server.js
import { McpCapabilityServer } from '@swob/agentic-ui'
import { CapabilityRegistry } from '@swob/capabilities'
import {
  registerSessionCapabilities,
  registerSearchCapabilities,
  registerFolderCapabilities
} from '@swob/capabilities'

const registry = new CapabilityRegistry()
registerSessionCapabilities(registry)
registerSearchCapabilities(registry)
registerFolderCapabilities(registry)

const mcpServer = new McpCapabilityServer(registry, {
  name: 'swob',
  version: '0.1.0'
})

// 简易 stdio MCP 协议实现
// MCP over stdio: 每行一个 JSON-RPC 2.0 消息
import * as readline from 'readline'

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false
})

async function handleMessage(request: {
  jsonrpc: string
  id?: number
  method: string
  params?: Record<string, unknown>
}): Promise<void> {
  const { id, method, params } = request

  try {
    let result: unknown

    switch (method) {
      case 'initialize':
        result = {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: mcpServer.getServerInfo()
        }
        break

      case 'tools/list':
        result = { tools: await mcpServer.listTools() }
        break

      case 'tools/call': {
        const toolName = params?.name as string
        const toolArgs = params?.arguments ?? {}
        result = await mcpServer.callTool(toolName, toolArgs)
        break
      }

      default:
        throw new Error(`Unknown method: ${method}`)
    }

    if (id !== undefined) {
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0',
        id,
        result
      }) + '\n')
    }
  } catch (error) {
    if (id !== undefined) {
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0',
        id,
        error: {
          code: -32603,
          message: error instanceof Error ? error.message : String(error)
        }
      }) + '\n')
    }
  }
}

rl.on('line', (line) => {
  try {
    const request = JSON.parse(line)
    handleMessage(request).catch(() => {})
  } catch {
    // ignore malformed JSON
  }
})
```

- [ ] **Step 2: 在 apps/swob/electron.vite.config.ts 中添加 mcp-server 入口**

在 main 配置的 entry 中添加 mcp-server 入口，确保它被编译。

- [ ] **Step 3: Commit**

```bash
cd ~/projects/swob-next && git add -A && git commit -m "feat: 添加 MCP Server stdio 入口（外部 Agent 可通过 MCP 调用 Swob 能力）"
```

---

### Task 4: 手动测试 MCP Server

通过命令行验证 MCP Server 能响应 tools/list 和 tools/call。

**Files:** 无新文件

- [ ] **Step 1: 构建**

```bash
cd ~/projects/swob-next/apps/swob && npx electron-vite build
```

- [ ] **Step 2: 测试 initialize**

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' | node ~/projects/swob-next/apps/swob/out/main/mcp-server.js
```

Expected: 返回 serverInfo: { name: "swob", version: "0.1.0" }

- [ ] **Step 3: 测试 tools/list**

```bash
printf '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}\n{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}\n' | node ~/projects/swob-next/apps/swob/out/main/mcp-server.js
```

Expected: 返回 10 个 tools（session.parse, session.summary, session.detail, session.search, folder.create, ...）

- [ ] **Step 4: 如果测试发现问题，修复并 commit**

---

## 自检

**1. Spec 覆盖：**
- ✅ MCP 适配器 → Task 2 + Task 3
- ✅ 自动映射 Registry → MCP Tools → Task 2
- ✅ stdio 传输 → Task 3
- ✅ 端到端验证 → Task 4
- ⏳ AG-UI 适配器 → 未来（当 AG-UI 协议更成熟时）

**2. 占位符：** 无 TODO/TBD

**3. 类型一致性：** McpCapabilityServer 使用 ICapabilityRegistry 接口（与 CapabilityBridge 一致）
