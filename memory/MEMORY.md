# Swob 项目记忆

## 项目概要
- **名称**: Swob (claude-session-manager)
- **定位**: local-first 的多 harness AI 编码会话桌面工作台
- **版本**: 以根目录 `package.json` 为准
- **GitHub**: https://github.com/IvyYang1999/swob

## 技术栈
- Electron + React 19 + TypeScript + Zustand + Tailwind CSS v4
- 构建工具: electron-vite
- 测试: Vitest (单元) + Playwright (E2E)
- 关键依赖: chokidar, lucide-react, react-markdown, remark-gfm

## 架构
- `src/main/`: 主进程 (session-loader, library-manager, insights, spotlight-search, config-store, cursor-loader, codex-loader)
- `src/renderer/src/`: 渲染进程 (App, store, components/)
- `src/preload/`: 预加载
- 组件: ChatViewer, InfoPanel, Sidebar, Toolbar, SettingsPanel, InsightsPage, SearchResults, MarkdownContent, SshConfigModal, UpdateBanner

## 关键文件
- `docs/PROJECT.md`: 项目架构和已完成功能
- `docs/DESIGN.md`: UI 设计规范（颜色/字号/间距），写 UI 必读
- `docs/ROADMAP.md`: 产品路线图
- `docs/PARALLEL.md`: 并行开发规范
- `AGENTS.md`: 协作、验收、合并与发布的唯一流程权威
- `CLAUDE.md`: 仅引用 `AGENTS.md`

## 开发规则
- `npm run dev` 热重载开发
- `npm test` 单元测试（pre-commit hook 自动跑）
- `npm run test:e2e` E2E 测试
- 修 bug 必须先写测试
- 测试名用中文，回归加 `【曾经的 bug】` 前缀
- Worker 只在独立 worktree 提交，不 push；仅 yyt 可以决定 push、部署与发布

## 已知技术债
- ChatViewer.tsx 1400+ 行，需拆分
- session-loader.ts 1000+ 行，解析/缓存/分支检测混在一起
- 分支 session 不可独立拖拽

## 路线图状态 (见 docs/ROADMAP.md)
- 线路 A: UI 打磨
- 线路 B: 侧边栏功能链
- 线路 C: 中间区域功能链
