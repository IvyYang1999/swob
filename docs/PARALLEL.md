# 并行开发

多个 Claude Code session 可以同时修改这个项目。使用 Claude Code 内置的 worktree 隔离，不需要手动管理。

## 怎么并行

在项目目录启动 Claude Code 时加 `--worktree` 参数：

```
claude --worktree 内嵌终端
claude --worktree 搜索优化
```

每个 session 自动获得独立的工作目录和分支，互不冲突。
如果使用 Claude Code Desktop，点 "+ New session" 即可，自动隔离。

## 做完后

退出 session 时：
- 没有改动：自动清理 worktree
- 有改动：提示保留还是合并到主分支

## 不用 worktree 时

如果多个 session 在同一个目录工作（比如都在 master 上），改代码前先 `git pull`，commit 前再 `git pull`。改完立刻 commit，不要攒改动。有冲突时解决冲突后再 commit。
