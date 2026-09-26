# CLI 会话定位与诊断

Swob CLI 可以只读定位 Library 中的会话包、检查派生数据是否落后，并只重建一个目标会话。定位命令只扫描轻量 manifest/registry 和文件元数据，不读取 transcript 正文，也不依赖 GUI 的 SQLite 搜索索引。

```bash
swob resolve <id-or-prefix> --json
swob where <id-or-prefix> --json
swob transcript status <id-or-prefix> --json
swob transcript rebuild <id-or-prefix> [--dry-run]
swob doctor locks --json
swob doctor library --json
swob doctor checkup --report <目录|文件.md> [--json]
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

## doctor checkup（只读内核体检）

```bash
swob doctor checkup [--report <目录|文件.md>] [--json] [--sources a,b] [--compare <上次.json>|none] [--fail-on fail|warn|never]
```

把 Swob 内核读到的会话，与原始数据的独立清点逐项对拍，生成老板看得懂的体检报告（设计：`内核体检报告设计-2026-09-26`）。本版给出 ① 会话纳入、② 内容完整、③ 压缩识别 三项结论，④⑤⑥ 显示为「无法判定（本版未实现）」；只支持全量体检，不接受 `--day`/`--since`/`--resume-sample`/`--seed`。

**只读保证。**

- 内核在模块加载时就记住 HOME，CLI 进程启动时已经用真实 HOME 加载过它。所以体检不在 CLI 进程里跑，而是在子进程里跑：CLI 用 `process.execPath` 启动与 `cli.js` 同目录的体检入口，环境里的 HOME、TMPDIR 和三个存储路径都指向 `os.tmpdir()` 下一次性的临时状态目录（其中的 HOME 只含指向各来源根的符号链接和一个空的 `.claude-session-manager`）。子进程开跑前先自检隔离，不通过就拒绝运行。
- 运行前后对 `~/.claude-session-manager`、`~/Library/Application Support/Swob`、`<库根>/.swob` 与各来源的 SQLite 主库做只读的元数据快照比对；只读打开 SQLite 碰到的 `-wal/-shm` 旁路文件只记录、不算变化。任何受保护位置有变化，就退出 `5`，不写报告。
- 临时状态目录用完即删。除 `--report` 指定的文件外，不写任何地方；Swob app 在运行时（`pgrep -x Swob`）拒绝体检。

**输出。**

- `--report <目录>`：写三个文件：`Swob内核体检-YYYY-MM-DD-<机器标签>.md`、同名 `.json`、`最新-<机器标签>.md`（当日 .md 的副本）。日期按本机时区；机器标签是报告 `saltFingerprint` 的前 6 位，两台机器写同一个同步目录也不会互相覆盖。stdout 是一行摘要（与 AI 日记同一行）；加 `--json` 时 stdout 是 `{ verdict, written, compare, readonlyAudit, worker }`，只含文件名、计数和原因码。
- `--report <文件.md>`：只写这个文件和同名 `.json`。
- 只给 `--json`：stdout 是完整的 CheckupReport JSON，不写文件。两个都不给：stdout 是 Markdown 报告。

**`--report` 目标规则。**

- 目录（或文件所在目录）必须已存在，且不是符号链接。可以是库根（例如整个 Obsidian vault）里的普通目录；不能落在各来源根、`~/.claude-session-manager`、`~/Library/Application Support/Swob`、`<库根>/.swob`、任何会话包目录（含 `.swob-session.json` 的目录及其以下）或体检的临时目录里。
- 同名文件已存在时，只有确认是本命令写的才覆盖：Markdown 首行是固定标记 `<!-- swob-kernel-checkup v1 -->`，JSON 是 `schemaVersion: 1` 且带 `kernel.checkupVersion`；否则退出 `1`，一个文件都不写。
- 所有文件先写临时文件再改名；任一步失败，已替换的文件会还原，不留下半套报告。

**和上次比。** 缺省时在 `--report` 目录里找同一机器标签的 `Swob内核体检-*.json`，只取 v1、`saltFingerprint` 与本次相同、范围相同的报告，按报告里的 `generatedAt` 取最新一份（不看 mtime），在写新文件之前选定。`--compare <文件>` 显式指定：文件不存在退出 `3`，不是 v1 报告退出 `1`，没有机器指纹或来自另一台机器也退出 `1`（开跑前就核对）。`--compare none` 关闭比对。比对结果只写进 Markdown，不写回 JSON。

**`--sources a,b`** 只体检这些来源，出现不认识的来源 id 退出 `1`。**`--fail-on`**：`fail` 在总评为不通过时退出 `4`，`warn` 在总评为注意或不通过时退出 `4`，`never`（默认）不影响退出码；报告照常写出，「无法判定」「不适用」不触发。

**隐私。** 报告与摘要只含隐私白名单接受的内容：数字、登记过的枚举/原因码/来源名/单位/模板句、`~` 开头的固定来源根、8 位加盐编号、ISO 时间、版本号、短 commit。渲染后的 JSON 与 Markdown 都要过扫描，任一命中退出 `7`，一个文件都不写。子进程的 stdout/stderr 只计行数，不转发；报错只给原因码（`error.code`），不带路径。

**平台。** Windows 上 `runtimeHome()` 不读 HOME，隔离 HOME 的办法不成立，直接退出 `1`（`checkup-windows-unsupported`）。

## 退出码与稳定错误码

| 退出码 | 含义 |
| --- | --- |
| `0` | 成功 |
| `1` | 执行被安全边界阻止或本地状态错误（`doctor checkup`：参数、执行或平台错误，含拒绝覆盖他人文件） |
| `2` | ID/前缀歧义 |
| `3` | 目标不存在（`doctor checkup`：`--compare` 指定的文件不存在） |
| `4` | `doctor checkup`：满足 `--fail-on` 条件，报告照常写出 |
| `5` | `doctor checkup`：只读或隔离保证不成立（临时状态目录校验失败、子进程隔离自检不通过、运行后审计发现受保护位置有变化），不写报告 |
| `6` | `doctor checkup`：Swob app 正在运行，拒绝体检 |
| `7` | `doctor checkup`：隐私扫描拒绝，不写任何文件 |

控制面可能返回：`IDENTIFIER_AMBIGUOUS`、`SESSION_NOT_FOUND`、`SESSION_IDENTITY_CONFLICT`、`LIBRARY_MANIFEST_CORRUPT`、`LIBRARY_SCAN_INCOMPLETE`、`ICLOUD_PLACEHOLDER`、`LIBRARY_WRITER_BUSY`、`TRANSCRIPT_SOURCE_UNAVAILABLE`。带 `--json` 的命令始终把业务结果写到 stdout；结构化错误写到 stderr。
