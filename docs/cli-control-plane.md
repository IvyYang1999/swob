# CLI 会话定位与诊断

Swob CLI 可以只读定位 Library 中的会话包、检查派生数据是否落后，并只重建一个目标会话。定位命令只扫描轻量 manifest/registry 和文件元数据，不读取 transcript 正文，也不依赖 GUI 的 SQLite 搜索索引。

```bash
swob resolve <id-or-prefix> --json
swob where <id-or-prefix> --json
swob transcript status <id-or-prefix> --json
swob transcript rebuild <id-or-prefix> [--dry-run]
swob doctor locks --json
swob doctor library --json
```

## 定位与新鲜度

`resolve` 以 Library 中的 `.swob-session.json` 为存在性事实。完整 manifest ID 总是解析为自己，lineage 缺失或损坏不会否决它。只有当 lineage alias 的最终 target 存在 manifest 且 registry binding 为 `bound` 时，alias 才成功；缺失 target、重复身份和歧义都 fail closed。短前缀只有在扫描完整且唯一时才成功；歧义返回退出码 `2` 和最小候选 ID 数组。

`where` 返回以下只读信息：

- `packagePath`；
- manifest、`transcript.md`、`backup.jsonl` 的路径、存在性、iCloud 占位状态和 mtime；
- manifest 记录的 source 路径及其存在性；
- `sourceUpdatedAt`、`transcriptUpdatedAt`、`backupUpdatedAt`、`manifestUpdatedAt`；
- freshness 与阻塞原因。

`transcript status` 是紧凑的机器接口。`basis/status/severity/requiredArtifacts/lagMs/stale/reasons` 直接消费 t192 的唯一 freshness DTO，CLI 不会再计算第二个 lag 或 stale。local source 要求 transcript + backup；canonical package 要求 canonical records + transcript，因此 canonical 缺 `backup.jsonl` 不是 stale。小于 60 秒的缺副本为 `syncing`，无法验证的 source 或时钟偏差保留 `lagMs: null`。

路径是这些命令的预期输出，但不会输出会话正文、密钥、writer nonce、device ID、boot identity 或进程启动指纹。

## 单会话重建

```bash
swob transcript rebuild <id-or-prefix> --dry-run
swob transcript rebuild <id-or-prefix>
```

dry-run 会解析目标 source/backup 并报告将写入的 transcript 数量，不取得 writer 锁、不写文件。正式执行先解析唯一 Library identity，只加载并修改目标包；损坏 manifest、重复身份、不可用 source/backup 或 iCloud placeholder 会 fail closed。核心包保留 t190 的 `transcript.md` + `backup.jsonl` + `.swob-session.json` 快照边界；branch transcript 是可再生的 best-effort 派生文件，不在该事务内，结果会单独报告 `branchFailed` 而不声称整个命令原子。

`swob transcript rebuild --all` 仍为兼容入口，但会遍历全库，不适合单会话事故恢复。

## Doctor

`doctor locks` 只调用 t190 权威 lease inspector，只读报告 writer 是否占用、owner PID/模式、存活性、heartbeat、lease、恢复证据哈希与是否可进入显式恢复。它不会创建 host identity 或 `.swob/locks`，不会删除或移动锁；活 owner 永远显示为不可抢占。

`doctor library` 返回明确标记为 `instantaneous-filesystem` 的 `LibraryDoctorSnapshot`，不伪造 Electron 运行时的 compensation/diagnostics 状态。它报告 `state`、`writeCapability`、目录可写性、manifest 数量、仅按 DTO `stale` 计算的 `staleCount`、单独的 `unverifiableCount`、identity conflict 和扫描问题。

## 退出码与稳定错误码

| 退出码 | 含义 |
| --- | --- |
| `0` | 成功 |
| `1` | 执行被安全边界阻止或本地状态错误 |
| `2` | ID/前缀歧义 |
| `3` | 目标不存在 |

控制面可能返回：`IDENTIFIER_AMBIGUOUS`、`SESSION_NOT_FOUND`、`SESSION_IDENTITY_CONFLICT`、`LIBRARY_MANIFEST_CORRUPT`、`LIBRARY_SCAN_INCOMPLETE`、`ICLOUD_PLACEHOLDER`、`LIBRARY_WRITER_BUSY`、`TRANSCRIPT_SOURCE_UNAVAILABLE`。带 `--json` 的命令始终把业务结果写到 stdout；结构化错误写到 stderr。
