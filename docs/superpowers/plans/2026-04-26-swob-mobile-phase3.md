# Swob Mobile Phase 3: AI Coding 优化

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 完善移动端 AI Coding 体验，让手机操作 Claude Code 的体验接近电脑。包括 yes/no 智能检测、自定义 Snippets、输入历史、横屏优化和 Settings 页完善。

**Architecture:** 在 Phase 2 基础上扩展。TerminalTab 监听终端输出检测 yes/no 提示并弹出快捷按钮；输入历史记录用户发送的命令并支持快速重发；Snippets 管理常用命令一键发送；Settings 页提供完整配置能力。

**Tech Stack:** React Native, Expo (bare), TypeScript, Zustand, @react-native-clipboard/clipboard

**Spec:** `docs/superpowers/specs/2026-04-25-swob-mobile-design.md`

---

## File Structure

Phase 3 新增/修改的文件：

```
swob-mobile/
├── lib/
│   ├── yes-no-detector.ts           # yes/no 提示检测
│   ├── input-history.ts             # 输入历史管理
│   └── types.ts                     # 新增 Snippet 类型
├── store/
│   ├── settings.ts                  # 扩展：Snippets 列表
│   └── terminal.ts                  # 扩展：输入历史、yes/no 检测状态
├── app/
│   ├── tabs/
│   │   ├── TerminalTab.tsx          # 修改：集成 yes/no 检测、输入历史、横屏
│   │   └── SettingsTab.tsx          # 新增：完整设置页
│   ├── screens/
│   │   └── SnippetEditScreen.tsx    # 新增：Snippet 编辑页
│   ├── components/
│   │   ├── SnippetPanel.tsx         # 新增：Snippets 快捷面板
│   │   └── InputHistoryPanel.tsx    # 新增：输入历史面板
│   └── navigation/
│       └── RootNavigator.tsx        # 修改：Settings 使用 SettingsTab
└── __tests__/
    ├── lib/yes-no-detector.test.ts
    ├── lib/input-history.test.ts
    ├── components/SnippetPanel.test.tsx
    ├── components/InputHistoryPanel.test.tsx
    └── store/settings-extended.test.ts
```

---

## Task 1: yes/no 提示检测器

**Files:**
- Create: `lib/yes-no-detector.ts`
- Create: `__tests__/lib/yes-no-detector.test.ts`

检测终端输出中是否包含 yes/no 确认提示。

- [ ] **Step 1: 写测试**

```typescript
// __tests__/lib/yes-no-detector.test.ts
import { detectYesNoPrompt } from '../../lib/yes-no-detector'

describe('detectYesNoPrompt', () => {
  it('检测 [Y/n] 提示', () => {
    expect(detectYesNoPrompt('Continue? [Y/n]')).toBe(true)
  })

  it('检测 [y/N] 提示', () => {
    expect(detectYesNoPrompt('Are you sure? [y/N]')).toBe(true)
  })

  it('检测 (yes/no) 提示', () => {
    expect(detectYesNoPrompt('Do you want to proceed? (yes/no)')).toBe(true)
  })

  it('检测 y/n 提示', () => {
    expect(detectYesNoPrompt('Accept? y/n')).toBe(true)
  })

  it('检测 Are you sure? 提示', () => {
    expect(detectYesNoPrompt('Are you sure you want to continue?')).toBe(true)
  })

  it('普通文本返回 false', () => {
    expect(detectYesNoPrompt('The quick brown fox')).toBe(false)
  })

  it('空字符串返回 false', () => {
    expect(detectYesNoPrompt('')).toBe(false)
  })

  it('检测 Do you want to continue? 提示', () => {
    expect(detectYesNoPrompt('Do you want to continue? (y)es/(n)o')).toBe(true)
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

```bash
npx jest __tests__/lib/yes-no-detector.test.ts
```
Expected: FAIL

- [ ] **Step 3: 实现 `lib/yes-no-detector.ts`**

```typescript
// lib/yes-no-detector.ts

const YES_NO_PATTERNS = [
  /\[Y\/n\]/,
  /\[y\/N\]/,
  /\[y\/n\]/i,
  /\(yes\/no\)/i,
  /\(y\/n\)/i,
  /\by\/n\b/i,
  /\(y\)es\/\(n\)o/i,
  /are you sure/i,
  /do you want to continue/i,
]

export function detectYesNoPrompt(text: string): boolean {
  if (!text) return false
  return YES_NO_PATTERNS.some((pattern) => pattern.test(text))
}
```

- [ ] **Step 4: 运行测试确认通过**

```bash
npx jest __tests__/lib/yes-no-detector.test.ts
```
Expected: 8 tests PASS

- [ ] **Step 5: Commit**

```bash
git add lib/yes-no-detector.ts __tests__/lib/yes-no-detector.test.ts
git commit -m "feat: yes/no 提示检测器"
```

---

## Task 2: 输入历史管理器

**Files:**
- Create: `lib/input-history.ts`
- Create: `__tests__/lib/input-history.test.ts`

管理终端命令输入历史，支持上下翻页和去重。

- [ ] **Step 1: 写测试**

```typescript
// __tests__/lib/input-history.test.ts
import { InputHistory } from '../../lib/input-history'

describe('InputHistory', () => {
  it('添加和获取历史', () => {
    const history = new InputHistory(10)
    history.add('ls -la')
    history.add('cd /tmp')
    expect(history.getAll()).toEqual(['cd /tmp', 'ls -la'])
  })

  it('超出容量时丢弃最旧记录', () => {
    const history = new InputHistory(2)
    history.add('first')
    history.add('second')
    history.add('third')
    expect(history.getAll()).toEqual(['third', 'second'])
  })

  it('重复命令提到最前', () => {
    const history = new InputHistory(10)
    history.add('ls')
    history.add('cd')
    history.add('ls')
    expect(history.getAll()).toEqual(['ls', 'cd'])
  })

  it('空字符串不记录', () => {
    const history = new InputHistory(10)
    history.add('')
    history.add('   ')
    expect(history.getAll()).toEqual([])
  })

  it('navigateUp/navigateDown 浏览历史', () => {
    const history = new InputHistory(10)
    history.add('first')
    history.add('second')
    history.add('third')

    expect(history.navigateUp()).toBe('third')
    expect(history.navigateUp()).toBe('second')
    expect(history.navigateUp()).toBe('first')
    expect(history.navigateUp()).toBe('first') // 到顶
    expect(history.navigateDown()).toBe('second')
    expect(history.navigateDown()).toBe('third')
    expect(history.navigateDown()).toBeNull() // 回到底
  })

  it('resetNavigation 重置导航位置', () => {
    const history = new InputHistory(10)
    history.add('cmd')
    history.navigateUp()
    history.resetNavigation()
    expect(history.navigateUp()).toBe('cmd')
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

```bash
npx jest __tests__/lib/input-history.test.ts
```
Expected: FAIL

- [ ] **Step 3: 实现 `lib/input-history.ts`**

```typescript
// lib/input-history.ts

export class InputHistory {
  private items: string[] = []
  private readonly maxSize: number
  private cursor = -1

  constructor(maxSize: number = 100) {
    this.maxSize = maxSize
  }

  add(input: string): void {
    const trimmed = input.trim()
    if (!trimmed) return

    // 去重：如果已存在则移到最前
    const idx = this.items.indexOf(trimmed)
    if (idx !== -1) {
      this.items.splice(idx, 1)
    }

    this.items.unshift(trimmed)

    // 超出容量时移除最旧
    if (this.items.length > this.maxSize) {
      this.items.pop()
    }

    this.resetNavigation()
  }

  getAll(): string[] {
    return [...this.items]
  }

  navigateUp(): string | null {
    if (this.items.length === 0) return null
    if (this.cursor < this.items.length - 1) {
      this.cursor++
    }
    return this.items[this.cursor] ?? null
  }

  navigateDown(): string | null {
    if (this.cursor > 0) {
      this.cursor--
      return this.items[this.cursor]
    }
    this.cursor = -1
    return null
  }

  resetNavigation(): void {
    this.cursor = -1
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

```bash
npx jest __tests__/lib/input-history.test.ts
```
Expected: 6 tests PASS

- [ ] **Step 5: Commit**

```bash
git add lib/input-history.ts __tests__/lib/input-history.test.ts
git commit -m "feat: 输入历史管理器"
```

---

## Task 3: Snippet 类型定义和 Settings Store 扩展

**Files:**
- Modify: `lib/types.ts` — 新增 Snippet 类型
- Modify: `store/settings.ts` — 新增 Snippets 管理
- Create: `__tests__/store/settings-extended.test.ts`

- [ ] **Step 1: 在 `lib/types.ts` 末尾追加 Snippet 类型**

```typescript
/** 用户自定义 Snippet（常用命令） */
export interface Snippet {
  id: string
  name: string
  command: string
}
```

- [ ] **Step 2: 写测试 `__tests__/store/settings-extended.test.ts`**

```typescript
import { useSettingsStore } from '../../store/settings'

describe('settings store - snippets', () => {
  beforeEach(() => {
    useSettingsStore.getState().reset()
  })

  it('添加 snippet', () => {
    const { addSnippet } = useSettingsStore.getState()
    addSnippet({ id: '1', name: 'Git Status', command: 'git status' })
    expect(useSettingsStore.getState().snippets).toHaveLength(1)
    expect(useSettingsStore.getState().snippets[0].name).toBe('Git Status')
  })

  it('删除 snippet', () => {
    const { addSnippet, removeSnippet } = useSettingsStore.getState()
    addSnippet({ id: '1', name: 'Test', command: 'test' })
    removeSnippet('1')
    expect(useSettingsStore.getState().snippets).toHaveLength(0)
  })

  it('更新 snippet', () => {
    const { addSnippet, updateSnippet } = useSettingsStore.getState()
    addSnippet({ id: '1', name: 'Old', command: 'old' })
    updateSnippet('1', { name: 'New' })
    expect(useSettingsStore.getState().snippets[0].name).toBe('New')
    expect(useSettingsStore.getState().snippets[0].command).toBe('old')
  })
})
```

- [ ] **Step 3: 运行测试确认失败**

- [ ] **Step 4: 修改 `store/settings.ts`**

在 SettingsState 中添加：
- `snippets: Snippet[]`
- `addSnippet: (snippet: Snippet) => void`
- `removeSnippet: (id: string) => void`
- `updateSnippet: (id: string, updates: Partial<Snippet>) => void`

在 reset 中添加 `snippets: []`。

- [ ] **Step 5: 运行测试确认通过**

```bash
npx jest __tests__/store/settings-extended.test.ts
npm test
```

- [ ] **Step 6: Commit**

```bash
git add lib/types.ts store/settings.ts __tests__/store/settings-extended.test.ts
git commit -m "feat: Snippet 类型和 Settings Store 扩展"
```

---

## Task 4: Snippet 面板组件

**Files:**
- Create: `app/components/SnippetPanel.tsx`
- Create: `__tests__/components/SnippetPanel.test.tsx`

- [ ] **Step 1: 写测试**

```typescript
// __tests__/components/SnippetPanel.test.tsx
import React from 'react'
import { render, fireEvent } from '@testing-library/react-native'
import { SnippetPanel } from '../../app/components/SnippetPanel'

describe('SnippetPanel', () => {
  const mockSelect = jest.fn()
  const snippets = [
    { id: '1', name: 'Git Status', command: 'git status' },
    { id: '2', name: 'Build', command: 'npm run build' },
  ]

  it('渲染 snippet 列表', () => {
    const { getByText } = render(
      <SnippetPanel snippets={snippets} onSelect={mockSelect} />
    )
    expect(getByText('Git Status')).toBeTruthy()
    expect(getByText('git status')).toBeTruthy()
  })

  it('点击 snippet 触发回调', () => {
    const { getByText } = render(
      <SnippetPanel snippets={snippets} onSelect={mockSelect} />
    )
    fireEvent.press(getByText('Git Status'))
    expect(mockSelect).toHaveBeenCalledWith('git status')
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

- [ ] **Step 3: 实现 `app/components/SnippetPanel.tsx`**

```typescript
import React from 'react'
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
} from 'react-native'
import type { Snippet } from '../../lib/types'

interface SnippetPanelProps {
  snippets: Snippet[]
  onSelect: (command: string) => void
  onClose?: () => void
}

export function SnippetPanel({ snippets, onSelect, onClose }: SnippetPanelProps) {
  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.headerText}>Snippets</Text>
        {onClose && (
          <TouchableOpacity onPress={onClose}>
            <Text style={styles.closeText}>关闭</Text>
          </TouchableOpacity>
        )}
      </View>
      <ScrollView style={styles.list}>
        {snippets.map((snippet) => (
          <TouchableOpacity
            key={snippet.id}
            style={styles.item}
            onPress={() => onSelect(snippet.command)}
          >
            <Text style={styles.nameText}>{snippet.name}</Text>
            <Text style={styles.commandText}>{snippet.command}</Text>
          </TouchableOpacity>
        ))}
        {snippets.length === 0 && (
          <Text style={styles.emptyText}>暂无 Snippet，在设置中添加</Text>
        )}
      </ScrollView>
    </View>
  )
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: '#27272a',
    borderTopWidth: 1,
    borderTopColor: '#3f3f46',
    maxHeight: 250,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#3f3f46',
  },
  headerText: {
    color: '#e4e4e7',
    fontSize: 14,
    fontWeight: '600',
  },
  closeText: {
    color: '#a1a1aa',
    fontSize: 13,
  },
  list: {
    paddingVertical: 4,
  },
  item: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#3f3f46',
  },
  nameText: {
    color: '#e4e4e7',
    fontSize: 14,
    fontWeight: '500',
  },
  commandText: {
    color: '#a1a1aa',
    fontSize: 12,
    fontFamily: 'monospace',
    marginTop: 2,
  },
  emptyText: {
    color: '#71717a',
    fontSize: 13,
    textAlign: 'center',
    paddingVertical: 20,
  },
})
```

- [ ] **Step 4: 运行测试确认通过**

- [ ] **Step 5: Commit**

```bash
git add app/components/SnippetPanel.tsx __tests__/components/SnippetPanel.test.tsx
git commit -m "feat: Snippet 面板组件"
```

---

## Task 5: 输入历史面板组件

**Files:**
- Create: `app/components/InputHistoryPanel.tsx`
- Create: `__tests__/components/InputHistoryPanel.test.tsx`

- [ ] **Step 1: 写测试**

```typescript
// __tests__/components/InputHistoryPanel.test.tsx
import React from 'react'
import { render, fireEvent } from '@testing-library/react-native'
import { InputHistoryPanel } from '../../app/components/InputHistoryPanel'

describe('InputHistoryPanel', () => {
  const mockSelect = jest.fn()
  const history = ['git status', 'npm test', 'claude --resume abc']

  it('渲染历史记录', () => {
    const { getByText } = render(
      <InputHistoryPanel history={history} onSelect={mockSelect} />
    )
    expect(getByText('git status')).toBeTruthy()
    expect(getByText('npm test')).toBeTruthy()
  })

  it('点击历史项触发回调', () => {
    const { getByText } = render(
      <InputHistoryPanel history={history} onSelect={mockSelect} />
    )
    fireEvent.press(getByText('git status'))
    expect(mockSelect).toHaveBeenCalledWith('git status')
  })

  it('空历史显示提示', () => {
    const { getByText } = render(
      <InputHistoryPanel history={[]} onSelect={mockSelect} />
    )
    expect(getByText('暂无输入历史')).toBeTruthy()
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

- [ ] **Step 3: 实现 `app/components/InputHistoryPanel.tsx`**

```typescript
import React from 'react'
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
} from 'react-native'

interface InputHistoryPanelProps {
  history: string[]
  onSelect: (command: string) => void
  onClose?: () => void
}

export function InputHistoryPanel({ history, onSelect, onClose }: InputHistoryPanelProps) {
  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.headerText}>输入历史</Text>
        {onClose && (
          <TouchableOpacity onPress={onClose}>
            <Text style={styles.closeText}>关闭</Text>
          </TouchableOpacity>
        )}
      </View>
      <ScrollView style={styles.list}>
        {history.map((cmd, idx) => (
          <TouchableOpacity
            key={`${cmd}-${idx}`}
            style={styles.item}
            onPress={() => onSelect(cmd)}
          >
            <Text style={styles.commandText} numberOfLines={1}>{cmd}</Text>
          </TouchableOpacity>
        ))}
        {history.length === 0 && (
          <Text style={styles.emptyText}>暂无输入历史</Text>
        )}
      </ScrollView>
    </View>
  )
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: '#27272a',
    borderTopWidth: 1,
    borderTopColor: '#3f3f46',
    maxHeight: 250,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#3f3f46',
  },
  headerText: {
    color: '#e4e4e7',
    fontSize: 14,
    fontWeight: '600',
  },
  closeText: {
    color: '#a1a1aa',
    fontSize: 13,
  },
  list: {
    paddingVertical: 4,
  },
  item: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#3f3f46',
  },
  commandText: {
    color: '#e4e4e7',
    fontSize: 13,
    fontFamily: 'monospace',
  },
  emptyText: {
    color: '#71717a',
    fontSize: 13,
    textAlign: 'center',
    paddingVertical: 20,
  },
})
```

- [ ] **Step 4: 运行测试确认通过**

- [ ] **Step 5: Commit**

```bash
git add app/components/InputHistoryPanel.tsx __tests__/components/InputHistoryPanel.test.tsx
git commit -m "feat: 输入历史面板组件"
```

---

## Task 6: TerminalTab 集成 yes/no 检测 + 输入历史 + Snippets

**Files:**
- Modify: `app/tabs/TerminalTab.tsx`

在 TerminalTab 中集成三个新功能：

1. **yes/no 智能检测**：监听终端输出，用 `detectYesNoPrompt` 检测，自动弹出 yes/no 大按钮
2. **输入历史**：用 `InputHistory` 记录用户发送的命令，键盘条上箭头弹出历史面板
3. **Snippets 面板**：扩展键盘条添加 Snippets 按钮，点击弹出 Snippet 列表

修改要点：
- 导入 `detectYesNoPrompt`、`InputHistory`、`SnippetPanel`、`InputHistoryPanel`
- 添加 `terminalOutput` state 追踪最近输出
- 添加 `inputHistory` ref（InputHistory 实例）
- 在 handleInput 中记录到 inputHistory
- 用 `useSettingsStore` 获取 snippets
- ExtendedKeyboard 已有 `showYesNo`/`onYes`/`onNo` props，只需在检测到 yes/no 提示时设 `showYesNo=true`
- 扩展键盘条添加 Snippets 按钮（通过 onShowSlashPanel 旁边的回调）

- [ ] **Step 1: 读取当前 `app/tabs/TerminalTab.tsx`**

- [ ] **Step 2: 修改 `app/tabs/TerminalTab.tsx`**

关键修改：
```typescript
// 新增导入
import { detectYesNoPrompt } from '../../lib/yes-no-detector'
import { InputHistory } from '../../lib/input-history'
import { SnippetPanel } from '../components/SnippetPanel'
import { InputHistoryPanel } from '../components/InputHistoryPanel'

// 在组件内
const inputHistoryRef = useRef(new InputHistory(50))
const [showSnippetPanel, setShowSnippetPanel] = useState(false)
const [showHistoryPanel, setShowHistoryPanel] = useState(false)
const [detectedYesNo, setDetectedYesNo] = useState(false)

// handleInput 中记录历史
const handleInput = useCallback((data: string) => {
  // 如果是完整命令（以 \r 结尾），记录到历史
  if (data.endsWith('\r')) {
    const cmd = data.slice(0, -1).trim()
    if (cmd) inputHistoryRef.current.add(cmd)
  }
}, [])

// 模拟终端输出检测（实际由原生模块 EventEmitter 驱动）
// 当收到终端输出数据时调用：
// if (detectYesNoPrompt(output)) setDetectedYesNo(true)

// Snippet 选择
const handleSnippetSelect = useCallback((command: string) => {
  handleInput(command + '\r')
  setShowSnippetPanel(false)
}, [handleInput])

// 历史选择
const handleHistorySelect = useCallback((command: string) => {
  handleInput(command + '\r')
  setShowHistoryPanel(false)
}, [handleInput])
```

渲染部分添加 SnippetPanel 和 InputHistoryPanel。

- [ ] **Step 3: 运行 `npm test` 确认所有测试通过**

- [ ] **Step 4: Commit**

```bash
git add app/tabs/TerminalTab.tsx
git commit -m "feat: TerminalTab 集成 yes/no 检测、输入历史、Snippets"
```

---

## Task 7: Snippet 编辑页面

**Files:**
- Create: `app/screens/SnippetEditScreen.tsx`

Snippet 的新增/编辑页面。

- [ ] **Step 1: 实现 `app/screens/SnippetEditScreen.tsx`**

```typescript
import React, { useState } from 'react'
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  Alert,
} from 'react-native'
import { useNavigation, useRoute, RouteProp } from '@react-navigation/native'
import { useSettingsStore } from '../../store/settings'
import type { Snippet } from '../../lib/types'

type RouteParams = { snippetId?: string }

export function SnippetEditScreen() {
  const navigation = useNavigation()
  const route = useRoute<RouteProp<{ params: RouteParams }, 'params'>>()
  const { snippets } = useSettingsStore()
  const { addSnippet, updateSnippet, removeSnippet } = useSettingsStore.getState()

  const snippetId = (route.params as RouteParams | undefined)?.snippetId
  const existing = snippetId
    ? snippets.find((s) => s.id === snippetId)
    : undefined

  const [name, setName] = useState(existing?.name || '')
  const [command, setCommand] = useState(existing?.command || '')

  const handleSave = () => {
    if (!name.trim() || !command.trim()) {
      Alert.alert('必填项', '请填写名称和命令')
      return
    }

    const snippet: Snippet = {
      id: existing?.id || `snippet-${Date.now()}`,
      name: name.trim(),
      command: command.trim(),
    }

    if (existing) {
      updateSnippet(existing.id, snippet)
    } else {
      addSnippet(snippet)
    }
    navigation.goBack()
  }

  const handleDelete = () => {
    if (!existing) return
    Alert.alert('删除', `确定删除 "${existing.name}"？`, [
      { text: '取消', style: 'cancel' },
      {
        text: '删除',
        style: 'destructive',
        onPress: () => {
          removeSnippet(existing.id)
          navigation.goBack()
        },
      },
    ])
  }

  return (
    <ScrollView style={styles.container}>
      <View style={styles.section}>
        <Text style={styles.label}>名称</Text>
        <TextInput
          style={styles.input}
          value={name}
          onChangeText={setName}
          placeholder="Git Status"
          placeholderTextColor="#52525b"
        />
      </View>

      <View style={styles.section}>
        <Text style={styles.label}>命令</Text>
        <TextInput
          style={[styles.input, styles.commandInput]}
          value={command}
          onChangeText={setCommand}
          placeholder="git status"
          placeholderTextColor="#52525b"
          autoCapitalize="none"
          autoCorrect={false}
          multiline
        />
      </View>

      <TouchableOpacity style={styles.saveButton} onPress={handleSave}>
        <Text style={styles.saveText}>保存</Text>
      </TouchableOpacity>

      {existing && (
        <TouchableOpacity style={styles.deleteButton} onPress={handleDelete}>
          <Text style={styles.deleteText}>删除</Text>
        </TouchableOpacity>
      )}
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#18181b',
  },
  section: {
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  label: {
    color: '#a1a1aa',
    fontSize: 13,
    marginBottom: 6,
  },
  input: {
    backgroundColor: '#27272a',
    color: '#e4e4e7',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
  },
  commandInput: {
    fontFamily: 'monospace',
    minHeight: 60,
    textAlignVertical: 'top',
  },
  saveButton: {
    backgroundColor: '#22c55e',
    marginHorizontal: 16,
    marginVertical: 20,
    paddingVertical: 14,
    borderRadius: 10,
    alignItems: 'center',
  },
  saveText: {
    color: '#ffffff',
    fontSize: 16,
    fontWeight: '600',
  },
  deleteButton: {
    marginHorizontal: 16,
    marginBottom: 20,
    paddingVertical: 14,
    borderRadius: 10,
    alignItems: 'center',
    backgroundColor: '#7f1d1d',
  },
  deleteText: {
    color: '#fca5a5',
    fontSize: 16,
    fontWeight: '600',
  },
})
```

- [ ] **Step 2: Commit**

```bash
git add app/screens/SnippetEditScreen.tsx
git commit -m "feat: Snippet 编辑页面"
```

---

## Task 8: Settings 完整页面

**Files:**
- Create: `app/tabs/SettingsTab.tsx`

替换之前的占位 Settings 页。包含 SSH 连接管理、终端设置、Snippet 管理、关于页。

- [ ] **Step 1: 实现 `app/tabs/SettingsTab.tsx`**

```typescript
import React from 'react'
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  Switch,
  Alert,
} from 'react-native'
import { useNavigation } from '@react-navigation/native'
import { useSettingsStore } from '../../store/settings'
import { useTerminalStore } from '../../store/terminal'

export function SettingsTab() {
  const navigation = useNavigation()
  const { terminalSettings, setTerminalSettings, snippets, sshConnections } =
    useSettingsStore()
  const { connections, removeConnection } = useTerminalStore()

  return (
    <ScrollView style={styles.container}>
      {/* SSH 连接 */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>SSH 连接</Text>
        {connections.map((conn) => (
          <View key={conn.id} style={styles.card}>
            <View style={styles.cardContent}>
              <Text style={styles.cardTitle}>{conn.name}</Text>
              <Text style={styles.cardSubtitle}>
                {conn.user}@{conn.host}:{conn.port}
              </Text>
            </View>
            <View style={styles.cardActions}>
              <TouchableOpacity
                onPress={() =>
                  (navigation as any).navigate('SshConfig', {
                    connectionId: conn.id,
                  })
                }
              >
                <Text style={styles.editText}>编辑</Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={() => {
                  Alert.alert('删除', `删除 "${conn.name}"？`, [
                    { text: '取消', style: 'cancel' },
                    {
                      text: '删除',
                      style: 'destructive',
                      onPress: () => removeConnection(conn.id),
                    },
                  ])
                }}
              >
                <Text style={styles.deleteText}>删除</Text>
              </TouchableOpacity>
            </View>
          </View>
        ))}
        <TouchableOpacity
          style={styles.addButton}
          onPress={() => (navigation as any).navigate('SshConfig')}
        >
          <Text style={styles.addButtonText}>+ 添加连接</Text>
        </TouchableOpacity>
      </View>

      {/* 终端设置 */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>终端</Text>
        <View style={styles.row}>
          <Text style={styles.rowLabel}>字号</Text>
          <View style={styles.fontSizeButtons}>
            {[12, 14, 16, 18].map((size) => (
              <TouchableOpacity
                key={size}
                style={[
                  styles.fontSizeButton,
                  terminalSettings.fontSize === size && styles.fontSizeActive,
                ]}
                onPress={() => setTerminalSettings({ fontSize: size })}
              >
                <Text style={styles.fontSizeText}>{size}</Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>
        <View style={styles.row}>
          <Text style={styles.rowLabel}>主题</Text>
          <View style={styles.fontSizeButtons}>
            {(['dark', 'light'] as const).map((theme) => (
              <TouchableOpacity
                key={theme}
                style={[
                  styles.fontSizeButton,
                  terminalSettings.theme === theme && styles.fontSizeActive,
                ]}
                onPress={() => setTerminalSettings({ theme })}
              >
                <Text style={styles.fontSizeText}>
                  {theme === 'dark' ? '深色' : '浅色'}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>
      </View>

      {/* Snippets */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Snippets</Text>
        {snippets.map((snippet) => (
          <View key={snippet.id} style={styles.card}>
            <View style={styles.cardContent}>
              <Text style={styles.cardTitle}>{snippet.name}</Text>
              <Text style={styles.cardSubtitle} numberOfLines={1}>
                {snippet.command}
              </Text>
            </View>
            <View style={styles.cardActions}>
              <TouchableOpacity
                onPress={() =>
                  (navigation as any).navigate('SnippetEdit', {
                    snippetId: snippet.id,
                  })
                }
              >
                <Text style={styles.editText}>编辑</Text>
              </TouchableOpacity>
            </View>
          </View>
        ))}
        <TouchableOpacity
          style={styles.addButton}
          onPress={() => (navigation as any).navigate('SnippetEdit')}
        >
          <Text style={styles.addButtonText}>+ 添加 Snippet</Text>
        </TouchableOpacity>
      </View>

      {/* 关于 */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>关于</Text>
        <Text style={styles.aboutText}>Swob Mobile v1.0.0</Text>
        <Text style={styles.aboutText}>Claude Code 移动伴侣</Text>
      </View>
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#18181b',
  },
  section: {
    paddingHorizontal: 16,
    paddingVertical: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#27272a',
  },
  sectionTitle: {
    color: '#e4e4e7',
    fontSize: 16,
    fontWeight: '600',
    marginBottom: 12,
  },
  card: {
    backgroundColor: '#27272a',
    borderRadius: 8,
    padding: 12,
    marginBottom: 8,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  cardContent: {
    flex: 1,
  },
  cardTitle: {
    color: '#e4e4e7',
    fontSize: 14,
    fontWeight: '500',
  },
  cardSubtitle: {
    color: '#71717a',
    fontSize: 12,
    fontFamily: 'monospace',
    marginTop: 2,
  },
  cardActions: {
    flexDirection: 'row',
    gap: 12,
  },
  editText: {
    color: '#7c3aed',
    fontSize: 13,
  },
  deleteText: {
    color: '#ef4444',
    fontSize: 13,
  },
  addButton: {
    paddingVertical: 10,
    alignItems: 'center',
  },
  addButtonText: {
    color: '#7c3aed',
    fontSize: 14,
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 8,
  },
  rowLabel: {
    color: '#a1a1aa',
    fontSize: 14,
  },
  fontSizeButtons: {
    flexDirection: 'row',
    gap: 6,
  },
  fontSizeButton: {
    backgroundColor: '#27272a',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 6,
  },
  fontSizeActive: {
    backgroundColor: '#7c3aed',
  },
  fontSizeText: {
    color: '#e4e4e7',
    fontSize: 13,
  },
  aboutText: {
    color: '#71717a',
    fontSize: 13,
    marginBottom: 4,
  },
})
```

- [ ] **Step 2: Commit**

```bash
git add app/tabs/SettingsTab.tsx
git commit -m "feat: Settings 完整页面（SSH/终端/Snippets/关于）"
```

---

## Task 9: 导航集成 SettingsTab 和 SnippetEditScreen

**Files:**
- Modify: `app/navigation/RootNavigator.tsx`

- [ ] **Step 1: 修改 RootNavigator**

将 Settings 的 PlaceholderSettings 替换为 SettingsTab。在 SessionsStack 和 TerminalStack 中都添加 SnippetEdit 路由。

关键修改：
- 导入 `SettingsTab` 和 `SnippetEditScreen`
- Tab Navigator 的 Settings Screen 改用 `SettingsTab`
- SessionsStack 添加 SnippetEdit 路由
- TerminalStack 添加 SnippetEdit 路由

- [ ] **Step 2: 运行 `npm test` 确认所有测试通过**

- [ ] **Step 3: Commit**

```bash
git add app/navigation/RootNavigator.tsx
git commit -m "feat: 导航集成 SettingsTab 和 SnippetEdit"
```

---

## Task 10: 横屏优化

**Files:**
- Modify: `app/tabs/TerminalTab.tsx`

- [ ] **Step 1: 修改 TerminalTab 添加横屏检测**

使用 `useWindowDimensions` 检测横竖屏，横屏时：
- 隐藏标签页栏
- 隐藏底部 Tab 栏（通过 navigation 设置 tabBarStyle 为 display: none）
- 终端占满全屏

```typescript
import { useWindowDimensions } from 'react-native'

// 在组件内
const { width, height } = useWindowDimensions()
const isLandscape = width > height
```

横屏时 tab bar 隐藏通过 `navigation.setOptions` 设置：
```typescript
useEffect(() => {
  navigation.setOptions({
    tabBarStyle: isLandscape ? { display: 'none' } : {
      backgroundColor: '#18181b',
      borderTopColor: '#27272a',
    },
  })
}, [isLandscape, navigation])
```

横屏时标签页栏用浮动按钮替代。

- [ ] **Step 2: 运行 `npm test` 确认通过**

- [ ] **Step 3: Commit**

```bash
git add app/tabs/TerminalTab.tsx
git commit -m "feat: 横屏优化（隐藏 Tab 栏、终端全屏）"
```

---

## Task 11: 全量测试验证

- [ ] **Step 1: 运行全量测试**

```bash
npm test
```
Expected: 全部测试通过

- [ ] **Step 2: TypeScript 检查**

```bash
npx tsc --noEmit
```
Expected: 零错误

- [ ] **Step 3: 查看 git log 确认所有 commit**

```bash
git log --oneline
```

---

## 自检清单

**Spec 覆盖检查：**

| Spec 要求 | 对应 Task |
|-----------|-----------|
| Slash 命令面板 | Phase 2 Task 8 已完成 |
| 自定义 Snippets | Task 3, 4, 7, 8 |
| yes/no 快捷按钮 | Task 1, 6 |
| 输入历史 | Task 2, 5, 6 |
| 横屏优化 | Task 10 |
| Settings 页（SSH/外观/Snippets/关于） | Task 8, 9 |

**Placeholder 扫描：** 无 TBD/TODO。

**类型一致性：** `Snippet` 类型在 Task 3 定义，Task 4/7/8 中一致使用。
