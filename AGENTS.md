# Swob 研发协作唯一规范

本文件是仓库内 Agent 协作、验收、合并与发布的唯一流程权威。`CLAUDE.md`、`docs/PROJECT.md`、`docs/PARALLEL.md` 只能引用或补充事实，不得定义冲突流程。

## 不可越过的边界

- Worker 只能在独立 worktree 和任务分支工作；不得直接修改 `master`，不得 push。
- 一个工作包只有一个 Owner。Builder 完成实现与本地证据，但 Builder 不得充当该工作包的 Verifier。
- 只有 Integrator 可以把已验收的工作包送入集成分支；语义冲突必须暂停并交回 Integrator/人类，不得自动猜测解决。
- 只有 yyt 可以发布。Agent、脚本和 Git hook 均不得自动 push、部署、替换或重启应用。
- 每个独立改动单独提交；提交前运行与风险相称的验证。不得混入其他工作包或用户未提交改动。

## 角色与职责

| 角色 | 默认承担者 | 唯一职责 | 禁止事项 |
| --- | --- | --- | --- |
| Product Owner | yyt | 定义目标、优先级、接受标准与发布决定 | 不把含糊目标直接下放为实现 |
| Fable | Fable | 仅在 S2/S3 做契约与任务图、语义冲突裁决、最终 Judge | 不承担普通调研、实现或机械合并 |
| Mapper | Codex | 只读勘察代码、依赖、风险、测试与事实边界 | 不在勘察阶段改代码 |
| Contract Owner | 对目标领域最强的模型/人 | 固化接口、数据与行为契约 | 不同时分配重叠 Owner |
| Builder | Codex 或 Opus，按工作包选择 | 在独立 worktree 实现一个明确工作包并提交证据 | 不提前集成，不验证自己的高风险产出 |
| Verifier | 独立上下文；高风险时换模型或人 | 按验收标准复核结果与证据 | 不以 Builder 自证代替独立验收 |
| Integrator | Codex + Merge Queue | 只接收合格 `result.json`，顺序合并、运行门禁、报告冲突 | 不发布，不自动解决语义冲突 |
| Release | yyt | 审阅集成结论后决定 push/部署/发布 | 不把发布授权隐含给 Agent 或 hook |
| Learning Miner | GLM | 从已完成批次提炼可复用经验 | 不改变当批实现或验收结论 |

## 生命周期

- S0：需求目标、成功标准或边界仍不清楚；先由 Product Owner 澄清。
- S1：边界清楚、低耦合；Mapper 可直接形成独立工作包。
- S2：跨模块或契约变化；Fable 先产出契约与依赖图，再分配 Builder。
- S3：高风险、语义冲突或发布决策；Fable/Judge 与人类介入。

工作包按 `mapped → contracted → claimed → built → verified → integrated → releasable` 单向推进；失败退回产生失败的阶段，不靠跳过门禁推进。

## 分支、worktree 与提交

1. 从最新的受信任基线创建任务分支和独立 worktree；一个 worktree 只承载一个工作包。
2. 开工前记录 `baseSha`、Owner、`write_scope`、验收证据和依赖；写入范围交集在开工前消解。
3. Worker 只提交到自己的任务分支。每个 Agent 提交必须包含以下 trailers，未知值写 `n/a`，不得省略：

   ```text
   Agent-Task: <work-item-id>
   Agent-Harness: <codex|claude-code|other>
   Agent-Model: <model>
   Agent-Session: <session-id>
   Agent-Decision: <关键取舍，单行>
   Agent-Limitation: <已知限制，单行；无则 none>
   ```

4. Worker 完成后只提交 `result.json` 和分支/commit 定位，不 push。Verifier 独立复核后，Integrator 才可运行 Merge Queue。
5. Merge Queue 只能生成“可 push”或“不可 push/需处理”的结论；真正的 push、部署和发布始终由 yyt 执行。

## `result.json` 交接契约

每个工作包根目录提交一个 `result.json`。`headSha` 指向待集成的实现提交；如果 manifest 自身是随后单独提交，`headSha` 不包含该 manifest 提交，以避免提交哈希自引用。

```json
{
  "workItemId": "t174a-kimi",
  "baseSha": "<40-char commit>",
  "headSha": "<40-char implementation commit>",
  "changedFiles": ["src/main/providers/kimi-provider.ts"],
  "contractsProduced": ["KimiProvider.v2"],
  "tests": [
    { "command": "npx vitest run", "status": "passed", "numbers": "1017/11" }
  ],
  "visualEvidence": [],
  "deviations": [],
  "knownRisks": [],
  "provenance": {
    "harness": "codex",
    "model": "<model>",
    "session": "<session-id>"
  },
  "depends_on": []
}
```

示例中的字段全部必填；无内容的数组也必须显式写 `[]`，不能靠缺省隐藏事实。`changedFiles` 必须与 `baseSha..headSha` 的真实 Git diff 完全相同；所有测试项必须为 `passed`。依赖存在时用 `depends_on` 声明工作包 ID，无依赖时写空数组。

## 验收与集成门禁

- Builder 提交工作包相关测试、静态检查和必要的视觉证据；涉及可视界面时必须真实回看交互，不以代码检查代替。
- Verifier 从验收标准和真实 diff 独立复核，记录失败证据，不替 Builder 悄悄补实现。
- Integrator 逐包执行 `git merge --no-commit`，每层通过 `npm run check` 后才提交；冲突时保留现场并报告冲突文件及双方 blame 摘要。
- 全部合并后运行：`npm run check`、`npx vitest run --maxWorkers=2`、`npm run build`、非 Windows 原生 E2E，以及全仓 `^<<<<<<<` 扫描。任何一项失败都不得输出“可 push”。
- 本机 hook 只是辅助门禁，不是流程权威。有效 hook 不得包含自动 push/deploy；历史备份也不得被重新启用。

## 项目入口

- 当前产品与架构事实：`docs/PROJECT.md`
- worktree、认领与交接操作：`docs/PARALLEL.md`
- UI 设计规范：`docs/DESIGN.md`
- 工作流图校验：`swob-workflow validate [graph.yaml|directory]`
- Merge Queue：`node scripts/workflow/merge-queue.mjs --manifests <result.json...>`
