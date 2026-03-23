# 设计规范

## 颜色语义

写 className 时用语义思考，不要随手挑颜色。

| 语义 | Tailwind class | 用在哪 |
|------|---------------|--------|
| 主背景 | `bg-zinc-900` | App 最外层 |
| 面板/卡片背景 | `bg-zinc-800` | 侧边栏 hover、输入框、代码块 |
| 浮层/弹出 | `bg-zinc-800 border border-zinc-600` | 搜索框、右键菜单 |
| 主文字 | `text-zinc-200` | session 标题、聊天正文 |
| 次要文字 | `text-zinc-400` | section 标题、文件夹名 |
| 辅助文字 | `text-zinc-500` | 日期、轮次统计 |
| 禁用/最弱 | `text-zinc-600` | 数量标注、分隔线 |
| 活跃状态 | `bg-green-400` | active 绿点 |
| 用户消息 | `text-blue-400` | 用户头像 icon |
| 助手消息 | `text-amber-500` | 助手头像 icon |
| 分支 | `bg-purple-900/50 text-purple-400` | 分支标签、共享上下文 |
| 历史/compact | `bg-amber-900/50 text-amber-400` | compact 标签、折叠区 |
| 高亮/笔记 | `bg-green-900/10 border-green-800/20` | 划线笔记卡片 |
| 危险/删除 | `text-red-400` | 删除按钮 hover |
| 选中状态 | `bg-zinc-800 border-l-2 border-blue-500` | 当前选中的 session |

## 字号梯度

只用以下 7 级，不要自己发明其他值。

| 级别 | class | 用途 |
|------|-------|------|
| 微标签 | `text-[10px]` | badge（compact、分支、匹配数） |
| 工具/UI控件 | `text-[11px]` | 工具调用标签、按钮文字、TOC 条目、时间戳 |
| 代码 | `text-[12px] font-mono` | 代码块、源码视图、命令输出 |
| 辅助 | `text-xs` (12px) | 日期、统计、meta 信息（非等宽场景） |
| 正文 | `text-sm` (14px) | session 标题、文件夹名、聊天正文 |
| 标题 | `text-base` (16px) | 面板标题、Markdown h4 |
| 大标题 | `text-lg` (18px) | 错误页标题、Markdown h3 |

## 间距梯度

优先使用以下值，保持节奏感一致。

| 用途 | 值 |
|------|-----|
| 元素内紧凑 | `gap-1` / `px-1` / `py-0.5` |
| 元素内标准 | `gap-2` / `px-2` / `py-1.5` |
| 区块之间 | `gap-3` / `px-3` / `py-2` |
| 面板内边距 | `p-4` |
| 大区域分隔 | `space-y-4` |

## 可复用模式

遇到以下模式时，提取为独立组件而不是复制 className。

### Badge（标签）
compact、分支、匹配数等小标签。
```
<span className="px-1 py-0.5 rounded text-[10px] bg-xxx text-xxx">内容</span>
```

### SectionHeader（可折叠区域标题）
InfoPanel 里的"高亮"、"工具统计"、"文件"等区域。
```
<button className="flex items-center gap-2 text-xs font-medium text-zinc-400 mb-2 hover:text-zinc-300 w-full">
  {open ? <ChevronDown /> : <ChevronRight />}
  <Icon />
  <span>标题</span>
  <span className="text-zinc-600 ml-auto">数量</span>
</button>
```
这个模式在 InfoPanel 里重复了 4 次，应该提取。

### IconButton（图标按钮）
hover 时变色的小图标按钮（删除、复制、新建等）。
```
<button className="opacity-0 group-hover:opacity-100 p-0.5 text-zinc-600 hover:text-xxx">
  <Icon size={12} />
</button>
```

## 新增 UI 时的规则

1. 先查这个文档，用已定义的颜色和字号
2. 不要发明新的颜色值——如果现有的不够用，先在这个文档里定义新的语义
3. 如果一个 UI 模式已经出现 2 次，提取为组件
4. 禁止发明梯度之外的字号——从 7 级里选。现有代码中 `text-[9px]` 是遗留问题，新代码不要用
