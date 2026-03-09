# Git 规则（强制）

每完成一个独立改动（一个 bug fix、一个小功能、一次重构），必须立即：
1. `git add` 相关文件（不要 `git add .`）
2. `git commit`，message 用中文，一句话说明改了什么
3. `git push origin master`

绝对不允许：
- 多个不相关功能塞进同一个 commit
- 写完一大堆代码才想起来 commit
- 只 commit 不 push

改动前先 `git status` 确认工作区干净。如果有未提交的改动，先处理掉再开始新工作。

# 开发规则

- 技术栈：Electron + React + TypeScript + Zustand + Tailwind CSS
- 构建工具：electron-vite
- 开发命令：`npm run dev`
- 构建命令：`npm run build:mac`
- 编译验证：每次改完代码跑 `npx electron-vite build` 确认编译通过，再 commit

# 本地部署（强制）

每次 commit + push 之后，必须立即运行：
```
npm run deploy
```
这会自动：退出正在运行的 Swob → 编译 → 打包 .app → 替换 /Applications/Swob.app → 重新启动。
不需要手动打包 DMG，不需要手动拖拽安装。
