# Agentic Desktop Phase 2 — Agentic UI 框架骨架

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 搭建 @swob/agentic-ui 包的核心抽象（UI 引擎 + Direct API 适配器），创建最小 Swob App 骨架验证能力可以通过框架驱动 UI。

**Architecture:** @swob/agentic-ui 是一个 React 库，提供 UIEngine（组件注册 + 布局描述渲染）和 CapabilityBridge（连接 Capability Registry 到 React 状态）。Swob App 作为 Electron 应用，导入两个包，注册组件和能力，通过布局描述驱动渲染。

**Tech Stack:** React 19, TypeScript, Electron, electron-vite, Tailwind CSS, Zustand

---

## 文件结构

```
swob-next/
├── packages/
│   ├── capabilities/                        # Phase 1 已完成
│   └── agentic-ui/                          # 本 Phase 新建
│       ├── package.json
│       ├── tsconfig.json
│       ├── vitest.config.ts
│       └── src/
│           ├── index.ts                        统一导出
│           ├── types.ts                        UIDescription, ComponentRegistry 等
│           ├── ui-engine/
│           │   ├── component-registry.ts        组件注册表
│           │   ├── component-registry.test.ts
│           │   ├── layout-renderer.tsx          布局渲染器 React 组件
│           │   └── layout-renderer.test.tsx
│           └── capability-bridge/
│               ├── bridge.ts                    连接 Registry → React
│               └── bridge.test.ts
│
├── apps/
│   └── swob/                                # 本 Phase 新建
│       ├── package.json
│       ├── tsconfig.json
│       ├── electron.vite.config.ts
│       ├── src/
│       │   ├── main/
│       │   │   └── index.ts                    Electron 主进程（最小版）
│       │   ├── preload/
│       │   │   └── index.ts                    Preload 脚本
│       │   └── renderer/
│       │       ├── index.html
│       │       ├── src/
│       │       │   ├── main.tsx                 React 入口
│       │       │   ├── App.tsx                  主应用（用 UIEngine 驱动）
│       │       │   ├── registrations.ts         注册组件和能力
│       │       │   └── components/              从现有 Swob 迁移
│       │       │       └── Placeholder.tsx       占位组件（验证用）
│       │       └── styles/
│       │           └── index.css
│       └── electron-builder.yml
```

---

### Task 1: 创建 @swob/agentic-ui 包结构

**Files:**
- Create: `packages/agentic-ui/package.json`
- Create: `packages/agentic-ui/tsconfig.json`
- Create: `packages/agentic-ui/vitest.config.ts`

- [ ] **Step 1: 创建目录**

```bash
mkdir -p ~/projects/swob-next/packages/agentic-ui/src/{ui-engine,capability-bridge}
```

- [ ] **Step 2: 创建 package.json**

```json
{
  "name": "@swob/agentic-ui",
  "version": "0.1.0",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "scripts": {
    "build": "tsc",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "peerDependencies": {
    "react": ">=18"
  },
  "devDependencies": {
    "@types/react": "^19.2.14",
    "jsdom": "^29.0.1",
    "react": "^19.2.4",
    "typescript": "^5.9.3",
    "vitest": "^4.1.0"
  }
}
```

- [ ] **Step 3: 创建 tsconfig.json**

```json
{
  "extends": "../../tsconfig.base.json",
  "include": ["src"],
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src",
    "jsx": "react-jsx"
  }
}
```

- [ ] **Step 4: 创建 vitest.config.ts**

```typescript
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    environment: 'jsdom'
  }
})
```

- [ ] **Step 5: 创建 types.ts**

```typescript
// packages/agentic-ui/src/types.ts
import type { ComponentType } from 'react'

/** UI 描述中的一个区域 */
export interface RegionDescription {
  component: string                // 注册的组件名
  data?: unknown                   // 传给组件的数据
  actions?: string[]               // 该区域支持的操作名
}

/** 完整的布局描述 */
export interface UIDescription {
  layout: string                   // 布局类型：split / single / tabs
  regions: Record<string, RegionDescription>
}

/** 组件注册信息 */
export interface RegisteredComponent {
  name: string
  component: ComponentType<Record<string, unknown>>
}
```

- [ ] **Step 6: 创建 index.ts（空壳）**

```typescript
// packages/agentic-ui/src/index.ts
export type { UIDescription, RegionDescription, RegisteredComponent } from './types'
```

- [ ] **Step 7: Install + Commit**

```bash
cd ~/projects/swob-next && npm install
git add -A
git commit -m "feat: 创建 @swob/agentic-ui 包结构"
```

---

### Task 2: 实现 ComponentRegistry

组件注册表：将组件名映射到 React 组件。

**Files:**
- Create: `packages/agentic-ui/src/ui-engine/component-registry.ts`
- Create: `packages/agentic-ui/src/ui-engine/component-registry.test.ts`

- [ ] **Step 1: 写失败测试**

```typescript
// packages/agentic-ui/src/ui-engine/component-registry.test.ts
import { describe, it, expect } from 'vitest'
import { ComponentRegistry } from './component-registry'

function MockComponent(props: Record<string, unknown>) {
  return `Mock: ${JSON.stringify(props)}`
}

describe('ComponentRegistry', () => {
  it('注册并获取组件', () => {
    const registry = new ComponentRegistry()
    registry.register('tree', MockComponent)

    const comp = registry.get('tree')
    expect(comp).toBe(MockComponent)
  })

  it('列出所有已注册组件名', () => {
    const registry = new ComponentRegistry()
    registry.register('tree', MockComponent)
    registry.register('chat-viewer', MockComponent)

    expect(registry.listNames()).toEqual(['tree', 'chat-viewer'])
  })

  it('获取未注册组件返回 undefined', () => {
    const registry = new ComponentRegistry()
    expect(registry.get('nonexistent')).toBeUndefined()
  })

  it('重复注册覆盖旧组件', () => {
    const registry = new ComponentRegistry()
    function V1() { return 'v1' }
    function V2() { return 'v2' }

    registry.register('tree', V1)
    registry.register('tree', V2)

    expect(registry.get('tree')).toBe(V2)
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

```bash
cd ~/projects/swob-next/packages/agentic-ui && npx vitest run src/ui-engine/component-registry.test.ts
```

- [ ] **Step 3: 实现 component-registry.ts**

```typescript
// packages/agentic-ui/src/ui-engine/component-registry.ts
import type { ComponentType } from 'react'

export class ComponentRegistry {
  private components = new Map<string, ComponentType<Record<string, unknown>>>()

  register(name: string, component: ComponentType<Record<string, unknown>>): void {
    this.components.set(name, component)
  }

  get(name: string): ComponentType<Record<string, unknown>> | undefined {
    return this.components.get(name)
  }

  listNames(): string[] {
    return Array.from(this.components.keys())
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

```bash
cd ~/projects/swob-next/packages/agentic-ui && npx vitest run src/ui-engine/component-registry.test.ts
```

- [ ] **Step 5: Commit**

```bash
cd ~/projects/swob-next && git add -A && git commit -m "feat: 实现 ComponentRegistry"
```

---

### Task 3: 实现 LayoutRenderer

根据 UIDescription 渲染 React 组件树的渲染器。

**Files:**
- Create: `packages/agentic-ui/src/ui-engine/layout-renderer.tsx`
- Create: `packages/agentic-ui/src/ui-engine/layout-renderer.test.tsx`

- [ ] **Step 1: 写失败测试**

```tsx
// packages/agentic-ui/src/ui-engine/layout-renderer.test.tsx
import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { createElement } from 'react'
import { LayoutRenderer } from './layout-renderer'
import { ComponentRegistry } from './component-registry'
import type { UIDescription } from '../types'

function TreeComponent(props: Record<string, unknown>) {
  return createElement('div', { 'data-testid': 'tree' }, `Tree: ${String(props.title || 'none')}`)
}

function ChatComponent(props: Record<string, unknown>) {
  return createElement('div', { 'data-testid': 'chat' }, `Chat: ${String(props.sessionId || 'none')}`)
}

describe('LayoutRenderer', () => {
  it('渲染 split 布局中的多个区域', () => {
    const registry = new ComponentRegistry()
    registry.register('tree', TreeComponent)
    registry.register('chat-viewer', ChatComponent)

    const layout: UIDescription = {
      layout: 'split',
      regions: {
        sidebar: { component: 'tree', data: { title: 'My Folders' } },
        main: { component: 'chat-viewer', data: { sessionId: 's1' } }
      }
    }

    const { getByTestId } = render(
      createElement(LayoutRenderer, { layout, componentRegistry: registry })
    )

    expect(getByTestId('tree').textContent).toBe('Tree: My Folders')
    expect(getByTestId('chat').textContent).toBe('Chat: s1')
  })

  it('组件不存在时渲染占位符', () => {
    const registry = new ComponentRegistry()

    const layout: UIDescription = {
      layout: 'single',
      regions: { main: { component: 'nonexistent' } }
    }

    const { container } = render(
      createElement(LayoutRenderer, { layout, componentRegistry: registry })
    )

    expect(container.textContent).toContain('nonexistent')
  })

  it('空布局渲染空内容', () => {
    const registry = new ComponentRegistry()
    const layout: UIDescription = { layout: 'single', regions: {} }

    const { container } = render(
      createElement(LayoutRenderer, { layout, componentRegistry: registry })
    )

    expect(container.children.length).toBe(0)
  })
})
```

- [ ] **Step 2: 安装 testing-library**

```bash
cd ~/projects/swob-next/packages/agentic-ui && npm install -D @testing-library/react
```

- [ ] **Step 3: 运行测试确认失败**

```bash
cd ~/projects/swob-next/packages/agentic-ui && npx vitest run src/ui-engine/layout-renderer.test.tsx
```

- [ ] **Step 4: 实现 layout-renderer.tsx**

```tsx
// packages/agentic-ui/src/ui-engine/layout-renderer.tsx
import { createElement, Fragment } from 'react'
import type { ComponentType } from 'react'
import type { UIDescription, RegionDescription } from '../types'
import type { ComponentRegistry } from './component-registry'

interface LayoutRendererProps {
  layout: UIDescription
  componentRegistry: ComponentRegistry
}

export function LayoutRenderer({ layout, componentRegistry }: LayoutRendererProps) {
  const regions = Object.entries(layout.regions)

  return createElement(
    layout.layout === 'split' ? 'div' : Fragment,
    layout.layout === 'split' ? { style: { display: 'flex', height: '100%' } } : null,
    ...regions.map(([name, desc]: [string, RegionDescription]) =>
      renderRegion(name, desc, componentRegistry)
    )
  )
}

function renderRegion(
  name: string,
  desc: RegionDescription,
  registry: ComponentRegistry
) {
  const Comp = registry.get(desc.component)

  if (!Comp) {
    return createElement(
      'div',
      { key: name, style: { padding: '1rem', color: '#999' } },
      `组件未注册: ${desc.component}`
    )
  }

  return createElement(
    'div',
    { key: name, style: { flex: name === 'main' ? 1 : undefined } },
    createElement(Comp, { ...desc.data as Record<string, unknown> })
  )
}
```

- [ ] **Step 5: 运行测试确认通过**

```bash
cd ~/projects/swob-next/packages/agentic-ui && npx vitest run
```

- [ ] **Step 6: Commit**

```bash
cd ~/projects/swob-next && git add -A && git commit -m "feat: 实现 LayoutRenderer（描述式 UI 渲染）"
```

---

### Task 4: 实现 CapabilityBridge

连接 CapabilityRegistry（能力层）到 React 状态。

**Files:**
- Create: `packages/agentic-ui/src/capability-bridge/bridge.ts`
- Create: `packages/agentic-ui/src/capability-bridge/bridge.test.ts`

- [ ] **Step 1: 写失败测试**

```typescript
// packages/agentic-ui/src/capability-bridge/bridge.test.ts
import { describe, it, expect } from 'vitest'
import { CapabilityBridge } from './bridge'
import { CapabilityRegistry } from '../../../capabilities/src/registry'
import type { Capability } from '../../../capabilities/src/types'

const echoCap: Capability<{ msg: string }, { echo: string }> = {
  name: 'test.echo',
  description: '回显',
  inputSchema: { type: 'object', properties: { msg: { type: 'string' } }, required: ['msg'] },
  outputSchema: { type: 'object', properties: { echo: { type: 'string' } } },
  execute: async (input) => ({ echo: input.msg })
}

describe('CapabilityBridge', () => {
  it('调用能力并返回结果', async () => {
    const capRegistry = new CapabilityRegistry()
    capRegistry.register(echoCap)

    const bridge = new CapabilityBridge(capRegistry)
    const result = await bridge.execute('test.echo', { msg: 'hello' })

    expect(result).toEqual({ echo: 'hello' })
  })

  it('调用不存在的能力抛出错误', async () => {
    const capRegistry = new CapabilityRegistry()
    const bridge = new CapabilityBridge(capRegistry)

    await expect(bridge.execute('nonexistent', {})).rejects.toThrow()
  })

  it('listCapabilities 返回能力元数据', () => {
    const capRegistry = new CapabilityRegistry()
    capRegistry.register(echoCap)

    const bridge = new CapabilityBridge(capRegistry)
    const list = bridge.listCapabilities()

    expect(list).toHaveLength(1)
    expect(list[0].name).toBe('test.echo')
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

```bash
cd ~/projects/swob-next/packages/agentic-ui && npx vitest run src/capability-bridge/bridge.test.ts
```

- [ ] **Step 3: 实现 bridge.ts**

```typescript
// packages/agentic-ui/src/capability-bridge/bridge.ts
import type { CapabilityRegistry } from '../../../capabilities/src/registry'
import type { CapabilityMetadata } from '../../../capabilities/src/types'

export class CapabilityBridge {
  constructor(private registry: CapabilityRegistry) {}

  async execute(name: string, input: unknown): Promise<unknown> {
    return this.registry.execute(name, input)
  }

  listCapabilities(): CapabilityMetadata[] {
    return this.registry.list()
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

```bash
cd ~/projects/swob-next/packages/agentic-ui && npx vitest run
```

- [ ] **Step 5: 更新 index.ts 导出所有 API**

```typescript
// packages/agentic-ui/src/index.ts
export type { UIDescription, RegionDescription, RegisteredComponent } from './types'
export { ComponentRegistry } from './ui-engine/component-registry'
export { LayoutRenderer } from './ui-engine/layout-renderer'
export { CapabilityBridge } from './capability-bridge/bridge'
```

- [ ] **Step 6: Commit**

```bash
cd ~/projects/swob-next && git add -A && git commit -m "feat: 实现 CapabilityBridge（Registry → React 桥接）"
```

---

### Task 5: 创建 Swob App 骨架

最小 Electron 应用，使用 @swob/agentic-ui 驱动 UI。

**Files:**
- Create: `apps/swob/package.json`
- Create: `apps/swob/tsconfig.json`
- Create: `apps/swob/electron.vite.config.ts`
- Create: `apps/swob/src/main/index.ts`
- Create: `apps/swob/src/preload/index.ts`
- Create: `apps/swob/src/renderer/index.html`
- Create: `apps/swob/src/renderer/src/main.tsx`
- Create: `apps/swob/src/renderer/src/App.tsx`
- Create: `apps/swob/src/renderer/src/registrations.ts`
- Create: `apps/swob/src/renderer/src/components/Placeholder.tsx`
- Create: `apps/swob/src/renderer/src/styles/index.css`

- [ ] **Step 1: 创建目录**

```bash
mkdir -p ~/projects/swob-next/apps/swob/src/{main,preload,renderer/{src/{components,styles}}}
```

- [ ] **Step 2: 创建 apps/swob/package.json**

```json
{
  "name": "swob",
  "version": "0.1.0",
  "main": "./out/main/index.js",
  "scripts": {
    "dev": "electron-vite dev",
    "build": "electron-vite build",
    "preview": "electron-vite preview"
  },
  "dependencies": {
    "@electron-toolkit/preload": "^3.0.2",
    "@electron-toolkit/utils": "^4.0.0",
    "@swob/capabilities": "*",
    "@swob/agentic-ui": "*",
    "react": "^19.2.4",
    "react-dom": "^19.2.4"
  },
  "devDependencies": {
    "@tailwindcss/vite": "^4.2.1",
    "@types/react": "^19.2.14",
    "@types/react-dom": "^19.2.3",
    "@vitejs/plugin-react": "^5.1.4",
    "electron": "^40.7.0",
    "electron-vite": "^5.0.0",
    "tailwindcss": "^4.2.1",
    "typescript": "^5.9.3"
  }
}
```

- [ ] **Step 3: 创建 apps/swob/tsconfig.json**

```json
{
  "compilerOptions": {
    "composite": true,
    "module": "ESNext",
    "moduleResolution": "bundler",
    "allowSyntheticDefaultImports": true,
    "esModuleInterop": true,
    "strict": true,
    "skipLibCheck": true,
    "target": "ESNext",
    "types": ["node"],
    "resolveJsonModule": true,
    "jsx": "react-jsx"
  },
  "include": ["src/**/*.ts", "src/**/*.tsx"]
}
```

- [ ] **Step 4: 创建 electron.vite.config.ts**

```typescript
// apps/swob/electron.vite.config.ts
import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()]
  },
  preload: {
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src')
      }
    },
    plugins: [react(), tailwindcss()]
  }
})
```

- [ ] **Step 5: 创建 main/index.ts（最小 Electron 主进程）**

```typescript
// apps/swob/src/main/index.ts
import { app, BrowserWindow } from 'electron'
import { join } from 'path'
import { electronApp, optimizer } from '@electron-toolkit/utils'

function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.swob')
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
```

- [ ] **Step 6: 创建 preload/index.ts**

```typescript
// apps/swob/src/preload/index.ts
import { contextBridge } from 'electron'
import { api } from '@electron-toolkit/preload'

// 最小 preload，后续通过 Capability Bridge 扩展
contextBridge.exposeInMainWorld('api', api)
```

- [ ] **Step 7: 创建 index.html**

```html
<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <title>Swob</title>
</head>
<body>
  <div id="root"></div>
  <script type="module" src="/src/main.tsx"></script>
</body>
</html>
```

- [ ] **Step 8: 创建 styles/index.css**

```css
@import "tailwindcss";

html, body, #root {
  height: 100%;
  margin: 0;
}
```

- [ ] **Step 9: 创建 components/Placeholder.tsx**

```tsx
// apps/swob/src/renderer/src/components/Placeholder.tsx
export function Placeholder({ name, data }: { name: string; data?: unknown }) {
  return (
    <div style={{ padding: '2rem', color: '#666' }}>
      <h2>{name}</h2>
      <pre>{JSON.stringify(data, null, 2)}</pre>
    </div>
  )
}
```

- [ ] **Step 10: 创建 registrations.ts**

```typescript
// apps/swob/src/renderer/src/registrations.ts
import { ComponentRegistry } from '@swob/agentic-ui'
import { CapabilityRegistry } from '@swob/capabilities'
import { registerSessionCapabilities } from '@swob/capabilities'
import { registerSearchCapabilities } from '@swob/capabilities'
import { registerFolderCapabilities } from '@swob/capabilities'
import { Placeholder } from './components/Placeholder'

// 创建并配置 Registry
export function createRegistries() {
  const componentRegistry = new ComponentRegistry()
  const capabilityRegistry = new CapabilityRegistry()

  // 注册组件（后续替换为真实组件）
  componentRegistry.register('sidebar', (props) => <Placeholder name="Sidebar" data={props} />)
  componentRegistry.register('chat-viewer', (props) => <Placeholder name="Chat Viewer" data={props} />)
  componentRegistry.register('info-panel', (props) => <Placeholder name="Info Panel" data={props} />)

  // 注册能力
  registerSessionCapabilities(capabilityRegistry)
  registerSearchCapabilities(capabilityRegistry)
  registerFolderCapabilities(capabilityRegistry)

  return { componentRegistry, capabilityRegistry }
}
```

- [ ] **Step 11: 创建 App.tsx**

```tsx
// apps/swob/src/renderer/src/App.tsx
import { useState } from 'react'
import { LayoutRenderer, CapabilityBridge } from '@swob/agentic-ui'
import type { UIDescription } from '@swob/agentic-ui'
import type { ComponentRegistry } from '@swob/agentic-ui'
import { createRegistries } from './registrations'

const { componentRegistry, capabilityRegistry } = createRegistries()
const bridge = new CapabilityBridge(capabilityRegistry)

const defaultLayout: UIDescription = {
  layout: 'split',
  regions: {
    sidebar: { component: 'sidebar', data: { title: 'Sessions' } },
    main: { component: 'chat-viewer', data: { sessionId: null } },
    info: { component: 'info-panel', data: {} }
  }
}

export function App() {
  const [layout] = useState(defaultLayout)
  const [capabilities] = useState(() => bridge.listCapabilities())

  return (
    <div style={{ display: 'flex', height: '100vh', fontFamily: 'system-ui' }}>
      <LayoutRenderer layout={layout} componentRegistry={componentRegistry} />
      <div style={{ position: 'fixed', bottom: 0, right: 0, padding: '0.5rem', fontSize: '0.75rem', color: '#999', background: '#f5f5f5' }}>
        {capabilities.length} capabilities loaded
      </div>
    </div>
  )
}
```

- [ ] **Step 12: 创建 main.tsx**

```tsx
// apps/swob/src/renderer/src/main.tsx
import { createRoot } from 'react-dom/client'
import { App } from './App'
import './styles/index.css'

createRoot(document.getElementById('root')!).render(<App />)
```

- [ ] **Step 13: Install + 验证编译**

```bash
cd ~/projects/swob-next && npm install
cd apps/swob && npx electron-vite build
```

如果编译报错，修复类型引用问题。注意 workspace 包之间的引用可能需要调整路径或使用 `tsconfig paths`。

- [ ] **Step 14: Commit**

```bash
cd ~/projects/swob-next && git add -A && git commit -m "feat: 创建 Swob App 骨架（Electron + Agentic UI）"
```

---

### Task 6: 端到端验证

验证 Swob App 能启动并展示由 Agentic UI 驱动的界面。

**Files:** 无新文件

- [ ] **Step 1: 验证全部测试通过**

```bash
cd ~/projects/swob-next && npm run test
```

- [ ] **Step 2: 验证编译通过**

```bash
cd ~/projects/swob-next && npm run build
```

- [ ] **Step 3: 启动 dev 模式**

```bash
cd ~/projects/swob-next/apps/swob && npm run dev
```

预期：Electron 窗口打开，显示三个占位组件（Sidebar / Chat Viewer / Info Panel），底部显示 "10 capabilities loaded"。

- [ ] **Step 4: 关闭 dev，Commit 任何修复**

如果启动过程中发现并修复了问题，commit 修复。

---

## 自检

**1. Spec 覆盖：**
- ✅ UI Engine（ComponentRegistry + LayoutRenderer）→ Task 2 + Task 3
- ✅ CapabilityBridge → Task 4
- ✅ Swob App 骨架 → Task 5
- ✅ 端到端验证 → Task 6
- ⏳ Agent Host → Phase 4
- ⏳ MCP/AG-UI 适配器 → Phase 3

**2. 占位符：** 无 TODO/TBD

**3. 类型一致性：** UIDescription 和 RegionDescription 在 types.ts 定义，LayoutRenderer 和 CapabilityBridge 使用同一套类型。
