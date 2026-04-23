# Swob

Claude Code 的可视化工作台 — 管理记忆、组织项目、延续对话。

AI 会忘（compact），你不会。

## 这是什么

Swob 是一个桌面应用，帮你浏览、搜索、组织和恢复所有 Claude Code 的对话记录。Claude Code 在 compact 时会丢失上下文，Swob 帮你把这些记忆找回来。

## 已实现的功能

### 会话浏览

- 自动扫描 `~/.claude/projects/` 下的所有 session 文件
- 按时间排序展示所有对话
- 实时监控：新 session 创建或更新时自动刷新
- 显示每个 session 的轮数、消息数、compact 次数

### 会话详情

- 完整的聊天记录展示（用户消息 + AI 回复）
- **Pre-compact 内容保留**：compact 前的完整对话可折叠展开，不再丢失
- 分段展示：原始对话 → compact 摘要 → 后续对话，层次清晰
- 工具调用展示：精简模式显示工具名和数量，完整模式展开参数详情
- Sidechain（rejected plan）标记：被拒绝的分支淡化显示
- 空消息过滤：自动隐藏无内容的 tool_result 等技术消息

### 分支管理

- 自动检测同一 session 的续写和分支
- 续写合并：session 结束后 resume 继续的对话自动合并为一个
- 分支分离：同时打开的多个分支各自独立展示
- 共享上下文：分支 session 自动加载分支点之前的父 session 对话作为上下文

### 搜索

- 全文搜索所有 session 的对话内容
- 支持正则表达式
- 搜索结果显示匹配片段和上下文
- 点击结果直接跳转到对应 session

### 文件夹组织

- 创建多级嵌套文件夹，自定义分类
- 拖拽 session 到文件夹
- 拖拽文件夹调整层级
- 文件夹支持颜色标签
- 双击重命名文件夹
- 右键菜单快速添加/移除 session
- 一个 session 同时只能在一个文件夹（自动移动）

### Resume 恢复

- 一键在终端恢复任意 session（`claude --resume`）
- 保留权限模式：`--dangerously-skip-permissions` 模式自动延续
- 批量 Resume：一键恢复整个文件夹内的所有 session
- 权限模式标签提示（红色 `skip-permissions` 徽章）

### 信息面板（右侧边栏）

- 会话元数据：创建/修改时间、轮数、消息数、compact 次数、文件大小
- 工作目录列表
- 文件操作记录：session 中读取、编辑、创建的所有文件，按目录树展示
- 用户上传图片列表
- 配置文件列表（CLAUDE.md 等）
- 工具调用统计
- Skill 调用记录
- CLAUDE.md 内容预览
- 点击文件路径可在 Finder 中打开

### 界面与交互

- 三栏布局：左侧导航 + 中央聊天 + 右侧信息
- 拖拽调整侧栏宽度
- 精简/完整视图模式切换
- macOS 原生窗口样式（traffic lights）
- 自定义 session 标题

## 技术栈

- **Electron** + **React** + **TypeScript**
- **Zustand** 状态管理
- **Tailwind CSS** 样式
- **Chokidar** 文件监控
- **electron-vite** 构建工具
- **Lucide** 图标库

## 开发

```bash
# 安装依赖
npm install

# 开发模式
npm run dev

# 构建 macOS DMG
npm run build:mac
```

## 构建产物

- macOS DMG（arm64 + x64）
- 产物命名：`swob-{version}-{arch}.dmg`

## 项目结构

```
src/
├── main/                    # Electron 主进程
│   ├── index.ts             # 应用入口、窗口管理、IPC 处理
│   ├── session-loader.ts    # Session 文件解析引擎
│   ├── config-store.ts      # 用户配置持久化
│   └── types.ts             # 类型定义
├── preload/
│   └── index.ts             # 安全的 IPC API 桥接
└── renderer/src/            # React 前端
    ├── App.tsx              # 主布局
    ├── store.ts             # Zustand 全局状态
    └── components/
        ├── Sidebar.tsx      # 左侧导航（文件夹树 + session 列表）
        ├── ChatViewer.tsx   # 聊天记录展示
        ├── Toolbar.tsx      # 顶部工具栏
        ├── InfoPanel.tsx    # 右侧信息面板
        └── SearchResults.tsx # 搜索结果
```
