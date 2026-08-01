# 七来源 Provider Protocol v2 能力真值表

权威定义在 `src/shared/seven-source-contract-v2.ts`；本表是发布审查摘要。每格的 fixture 与 conformance ID 由定义生成，门禁逐格验证文件存在、状态合法且 ID 唯一。

| 来源 | 发现 | 元数据 | 消息 | 工具 | 系统+compact | Token | 关系 | Resume |
|---|---|---|---|---|---|---|---|---|
| Claude Code | exact | exact | exact | exact | exact | exact | exact | exact |
| Codex | exact | exact | exact | exact | exact | derived | exact | exact |
| Cursor | exact | derived | derived | exact | unavailable | unavailable | unavailable | derived |
| OpenCode | exact | exact | exact | exact | unavailable | exact | exact | exact |
| ZCode | exact | exact | exact | exact | unavailable | exact | exact | derived |
| CC-Mirror | exact | exact | exact | exact | exact | exact | derived | derived |
| Pi | exact | exact | exact | exact | exact | exact | derived | derived |

关键边界：

- Cursor `store.db` 只作为 Resume/source anchor；不能从它伪造 transcript 或 usage。
- OpenCode/ZCode 通过 SQLite online backup 读取一致快照，包含已提交 WAL 页且不改源 DB；output 保留 provider 报告总值，reasoning 文本不自动推导数值子集。
- ZCode descriptor 独立，不因同属 SQLite/OpenCode 格式族继承语义。
- CC-Mirror 只继承 fixture 已证明的 Claude 字段；fork 私有扩展进入 `unknown` 事件。
- 七来源 Resume 都使用 `ResumeContract` 和相同的 source/anchor postcondition verifier。
- Pi v3 树的 parent 字段是 exact，active leaf/chain 由持久化顺序 derived；非 active 分支仍归档保留。
- 默认走统一 v2；`preferences.providerAdapterMode=legacy` 或 `SWOB_PROVIDER_ADAPTER_MODE=legacy` 全局回退，`preferences.legacyProviderSources` 按来源失败关闭。
