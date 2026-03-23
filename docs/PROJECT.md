# Swob — 项目概况

Claude Code 会话管理桌面应用。可视化浏览/搜索所有 Claude Code session，恢复 compact 前原始对话，一键 resume。

## 架构
- main 进程：session-loader.ts（JSONL 解析）、library-manager.ts（文件系统持久化）、index.ts（IPC + 文件监听）
- renderer 进程：ChatViewer.tsx（消息展示）、Sidebar.tsx（文件夹树）、InfoPanel.tsx（元数据）
- 状态管理：Zustand (store.ts)
- 数据源：~/.claude/projects/ 下的 JSONL 文件
- Library 存储：~/Library/Application Support/Swob/（不走 iCloud 同步）

## 已完成功能
- Session 列表 + 文件夹管理（树形结构、拖拽排序）
- 三种视图模式：精简/完整/Markdown
- Compact 前原始对话恢复
- 分支检测（同文件分支 + 跨文件续写）
- 全局搜索 (⌘K) + 局部搜索 (⌘F，支持 regex)
- CSS Custom Highlight API 实现搜索高亮
- 高亮笔记（选中文本 → 标注）
- 一键 resume 到 Terminal/iTerm2
- 双语 (zh-CN/en)
- 拖拽导出为 Markdown 上下文

## 已知问题
- ChatViewer.tsx 1400+ 行，应拆分为独立组件
- session-loader.ts 1000+ 行，解析/缓存/分支检测混在一起
- 分支 session 不可独立拖拽（与母 session 共享 Library 目录）

## Roadmap
参见 docs/roadmap.md（如存在）。当前 P1 是内嵌终端 (xterm.js + node-pty)。
