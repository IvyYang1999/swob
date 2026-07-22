# t116: spawn EBADF 与退出卡顿调查报告

日期:2026-07-22

分支:`debug/t116-spawn-ebadf`

基线:`21ad141`

## 结论

`spawn EBADF`的根因不在 `security` 命令或 agent pipe,而是库目录监听器耗尽文件描述符:

1. Swob 用 chokidar 5 递归监听整个 vault。chokidar 5 已不依赖 macOS FSEvents,底层使用 `fs.watch`,会按文件/目录持有 fd。
2. 真实 Finder 进程 PID 4269 稳定占满 10,000 个数字 fd,其中 9,974 个是唯一普通文件,主要位于当前文档库。启动初期 spawn 自检成功,监听器完成建表后,后续 `spawn` 才同步抛 `EBADF`。
3. 正常 Quit 需要回收近万个 watcher handle,基线 20 秒后仍未退出,最终约 20–22 秒才结束。因此 EBADF 与退出卡顿是同一根因的两个表现。

隔离实验进一步闭环:同一棵 2,101 路径测试树上,chokidar/Node 递归 `fs.watch` 触发 `EMFILE`;直接 FSEvents 仅 24 个进程 fd,关闭耗时 1ms。

## 修复

- macOS 的库目录监听改为单一 FSEvents 事件流;`fsevents` 声明为生产可选依赖。
- FSEvents 不可用时降级为单层安全监听并记录错误,不再在 macOS 回退到递归 `fs.watch`。
- 保留原有文件过滤语义,并按 FSEvents 的 `directory` 类型正确处理带扩展名的目录。
- `before-quit` 改为带 1.8s 总预算和每步预算的异步清理;每步耗时追加到 `~/.claude-session-manager/lifecycle.log`。
- agent 子进程退出使用 `SIGTERM(500ms) -> SIGKILL(250ms)`;活跃会话 `ps` 轮询进程可追踪并在退出时终止。
- chokidar source watcher、FSEvents watcher、TranscriptWatcher、SessionSyncCoordinator、LibraryWorker 和 global shortcuts 都在退出时显式关闭。
- `LibraryWorkerClient.close()` 现在返回并等待 `worker.terminate()`。

未修改 renderer/UI,也未改 `stdio-repair.ts` 的 fd 重绑语义。

## 实测数据

### FD / spawn 矩阵

| 场景 | FD | 结果 |
|---|---:|---|
| 旧包,Finder 启动,监听器就绪 | 10,000 数字 fd / 12,156 lsof 行 | 后续 spawn 可报 EBADF |
| 新包,Finder 启动,FSEvents 就绪 | 120–131 | `echo` 和两种 `security` spawn 自检全部成功 |
| 新包,初扫/索引期 | 204–207 | 40s 重复采样无回涨 |
| agent 回合1 前/后 | 211 -> 212 | Claude CLI 进程正常关闭,无残留 |
| agent 回合2 后 | 211 | 回到基线,无 pipe/fd 泄漏 |
| agent 2 轮后 `llm:saveProfile` | 211 | 远程错误中无 `spawn EBADF` |

agent 两轮都成功覆盖 Claude CLI spawn/close,但 CLI 返回当前 session limit,未生成模型回答。

Profile 保存不再报 EBADF,但当前本机仍有一个独立的历史数据迁移问题:`migrateLegacyLlmCredential` 在 Keychain 写入后读回校验不一致,因而按设计保留原配置并拒绝保存。测试表单已取消,没有创建测试 Profile。该问题不是 fd/spawn 问题,建议单独立项,并在不读取真实凭据的前提下做 Keychain 重复项/迁移幂等性调查。

### 退出

| 轮次 | 主进程消失 | cleanup | before-quit -> will-quit |
|---:|---:|---:|---:|
| 修复前 | 20–22s | 无分步数据 | 无分步数据 |
| 1(索引高负载) | 1.0s | 127ms | 231ms |
| 2 | 0.3s | 4ms | 73ms |
| 3 | 0.2s | 11ms | 20ms |
| 4 | 0.2s | 9ms | 16ms |
| 5 | 0.2s | 12ms | 19ms |

5/5 正常 Quit 都小于 3s,所有 cleanup step 都为 `ok`,无 timeout。

## 回归防线

- `library-directory-watcher.test.ts`:FSEvents 单流、路径/目录过滤、安全降级。
- `child-process-termination.test.ts`:TERM 正常退出与 KILL 升级。
- `runtime-cleanup.test.ts`:清理顺序、日志、总 deadline。
- `scripts/diagnostics/t116-watcher-fd-probe.mjs`:可重复 chokidar/native/FSEvents 的 FD 差异。

完整验证:`75 passed | 2 skipped` 测试文件,`673 passed | 3 skipped` 测试,`--maxWorkers=2`;生产 build 通过,并在干净 `npm ci` 依赖树上验证包内同时存在 `chokidar + readdirp + fsevents.node`。

## 发布注意

不要用 symlink 复用其他工作树的 `node_modules` 做 electron-builder 生产打包。实测会让 builder 漏收集 `readdirp`,导致 Electron 只启动外壳而主进程 JS 在首行前加载失败。必须使用锁文件对应的干净 `npm ci` 依赖树打包。
