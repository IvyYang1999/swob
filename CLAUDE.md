# 技术栈

Electron + React + TypeScript + Zustand + Tailwind CSS，构建工具 electron-vite。
项目详情见 `docs/PROJECT.md`，并行开发见 `docs/PARALLEL.md`，UI 设计规范见 `docs/DESIGN.md`。
写 UI 时必须先读 `docs/DESIGN.md`，用已定义的颜色/字号/间距，不要自己发明。

# Git 规则（强制）

每完成一个独立改动，立即 `git add` 相关文件 + `git commit`（中文 message）。
commit 后 git hook 自动：push → 编译 → 替换 /Applications/Swob.app → 重启。
pre-commit hook 自动跑 `npm test` + 编译检查，不过就拒绝 commit。
绝对不允许：多个不相关功能塞同一个 commit / 编译不过就 commit / 测试不过就 commit。
改动前先 `git status` 确认工作区干净。

# 并行开发（强制）

可能有多个 session 同时改这个项目。改代码前先 `git pull`，commit 前再 `git pull`。有冲突就解决。改完立刻 commit，不要攒改动。详见 `docs/PARALLEL.md`。

# 开发规则

- 日常调试用 `npm run dev`（热重载），不要每次都 build + deploy
- 编译验证：`npx electron-vite build`

# 测试规则（强制，不可跳过）

**修 bug 时，必须先写测试再改代码。** 没有测试的 bug fix 不允许 commit。

- `npm test`：逻辑测试，<1 秒，commit 前必跑（pre-commit hook 已自动执行）
- `npm run test:e2e`：UI 自动测试，~10 秒，改了交互后跑
- 测试文件放在被测文件旁边 `xxx.test.ts`，E2E 放 `e2e/`

何时写测试：修 bug（强制）→ 改了已有函数行为（强制）→ 新逻辑 → 改了交互用 E2E → 纯样式不需要。
测试名用中文，防回归加 `【曾经的 bug】` 前缀。

# Agent 犯过的错（每次犯新错就追加）

- 改了已有函数的行为但没更新测试用例
- 修 bug 时没有先写测试就直接改代码
- IPC 传参用位置参数导致 parentId 丢失，应该用 options 对象
- `~/Documents/` 会被 iCloud 同步，应用数据放 `~/Library/Application Support/`
- 分支 session 与母 session 共享 Library 目录，不能独立拖拽
- JSONL 中 `type: "user"` 但内容是 `<task-notification>` 的不是真实用户消息
- 全局 `document.addEventListener('drop', preventDefault)` 会拦截所有拖拽
- 新增逻辑函数后没有补测试（连续三次：formatTime、getBranchMdPath、detectActiveSessionsFromProcesses）
