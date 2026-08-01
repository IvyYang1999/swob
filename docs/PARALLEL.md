# 并行开发：worktree + claim

流程权威见根目录 `AGENTS.md`。并行开发的隔离单位不是“聊天”，而是一个有 Owner、写入范围和证据要求的工作包。

## 开工前认领

工作包必须先进入 `.swob/workflows/<batch>/graph.yaml`，至少声明：

```yaml
workItems:
  - id: t180-docs
    owner: codex-session-id
    depends_on: []
    write_scope:
      - AGENTS.md
      - docs/**
    evidence_required:
      - npm run workflow:selftest
```

运行 `swob-workflow validate .swob/workflows/<batch>/graph.yaml`。循环依赖、重复 Owner、缺失证据是错误；`write_scope` 交集是必须在开工前处理的警告。一个 Owner 同时只认领一个未完成工作包。

## 建立隔离 worktree

从受信任基线创建任务分支，分支名应能定位工作包：

```bash
git fetch origin
git worktree add -b feat/<work-item-id> ../swob-<work-item-id> origin/master
```

Claude Code 可用 `claude --worktree <work-item-id>` 创建等价隔离。其他 Agent 使用普通 `git worktree`。禁止多个 Agent 共用一个可写目录，也禁止在 `master` 上并行修改或用 pull 作为并发协调手段。

## 开发、交接与释放 claim

1. Owner 只修改 `write_scope` 内文件；发现越界或依赖变化时先更新任务图并重新校验。
2. Builder 在任务分支提交实现和本地证据，不 push。
3. Builder 生成 `result.json`；格式、commit trailers 与必跑门禁见 `AGENTS.md`。
4. Verifier 在独立上下文复核 diff、测试与必要视觉证据。通过后由 Integrator 把 manifest 送入 Merge Queue。
5. 只有进入 `integrated` 或明确取消的工作包才能释放 claim。失败工作包保留 Owner 和现场，回到对应阶段修复。

Merge Queue 遇到冲突会暂停并保留集成 worktree。Integrator 处理语义决策后重跑；脚本不会 push 或部署。yyt 是唯一 Release。
