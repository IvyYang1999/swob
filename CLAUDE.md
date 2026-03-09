# Git 规则（强制）

每完成一个独立改动（一个 bug fix、一个小功能、一次重构），必须立即：
1. `git add` 相关文件（不要 `git add .`）
2. `git commit`，message 用中文，一句话说明改了什么

commit 后 git hook 会自动完成：push → 编译 → 替换 /Applications/Swob.app → 重启。
不需要手动 push，不需要手动 deploy。

绝对不允许：
- 多个不相关功能塞进同一个 commit
- 写完一大堆代码才想起来 commit
- 编译不过就 commit

改动前先 `git status` 确认工作区干净。如果有未提交的改动，先处理掉再开始新工作。

# 开发规则

- 技术栈：Electron + React + TypeScript + Zustand + Tailwind CSS
- 构建工具：electron-vite
- 编译验证：每次改完代码跑 `npx electron-vite build` 确认编译通过，再 commit
- 开发调试：`npm run dev`（热重载，不需要重新打包）
- 手动部署：`npm run deploy`（通常不需要，hook 已自动处理）
