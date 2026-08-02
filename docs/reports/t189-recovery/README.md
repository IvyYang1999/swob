# t189 Library 恢复与 v1.4 候选版复验

> 日期：2026-08-02（Asia/Shanghai）<br>
> 隐私边界：本报告只保留数量、状态和不可逆哈希结论；不收录用户目录、会话正文、原始 JSONL、私有快照绝对路径或机器标识。

## 结论

- 死亡 writer 的恢复取证成立：owner 进程已死亡、boot identity 一致、heartbeat 与 lease 均停止推进；原锁证据被移到 Library 外的私有隔离目录，没有删除。
- 事故截止口径内的 12 个唯一绑定会话已全部原子补数，唯一绑定 stale 从 12 降为 0；source 与 backup 逐字节一致。
- 3 组历史重复身份（共 34 个非等价包）按用户授权保持只读，没有猜测式合并、移动或删除。
- t192 修复后的 v1.4 候选版已恢复持续增量写入：活动会话首次 durable backup 在进程启动后 33 秒出现，之后三次不同大小的快照均为 source 的精确字节前缀，CLI freshness 为 `fresh`。
- CLI 对事故样本完整 UUID 返回 `matched: true`、`ambiguous: false`。
- 实机复验同时发现并修复了一个新的并发 worker 回收缺陷：大源完成后不再取消同 worker 上已经接收的兄弟同步；新增确定性并发回归测试覆盖该路径。
- 全库启动同步仍是逐会话安全扫描；其增量化属于已登记且明确不进入 v1.4 的 t194。这个性能事实不改变上述恢复数据，但冻结验收必须如实记录启动健康状态和耗时。

## 写前取证与隔离

恢复前执行了以下只读核验：

1. 确认正式版、开发版和 E2E Swob writer 均已退出。
2. 复核另一台设备没有运行 Swob，避免双端同时恢复。
3. 对 owner 的 PID、boot identity、heartbeat、lease 和证据哈希做双次观察；仅在死亡且不再推进时进入恢复。
4. 对 Library manifest、目标 source、transcript、backup 只读取元数据与哈希，不读取或归档正文。
5. 将锁证据和写前快照保存在 Library 根以外、权限为 `0700` 的私有隔离目录；Git 中只保留本脱敏报告。

## 定向恢复

恢复程序先按逻辑 sessionId 分组：

| 分组 | 数量 | 动作 |
| --- | ---: | --- |
| 唯一绑定 | 12 | shadow 生成与校验后，持 writer lease 原子发布 |
| 历史歧义 | 3 组 / 34 包 | 只读保留，退出自动恢复 |

每个唯一目标经过：稳定 source 快照、shadow 候选生成、session/source 绑定校验、backup 字节校验、临时文件 fsync、原子 rename、manifest 最后提交、目录 fsync。没有调用全库猜测式 rebuild。

结果：dry-run 12/12 通过，apply 12/12 通过；恢复后 manifest 总数未增加，没有制造新的重复包。

## v1.4 候选版持续写入复验

复验使用显式 real-Library 开关启动本地候选版，并保留醒目的开发版横幅。验收只观察一个当前活跃会话的元数据与字节关系。

| 验收项 | 结果 |
| --- | --- |
| 首次 durable backup | 启动后 33 秒，低于 60 秒门槛 |
| 连续快照 1 | backup `122,675,103` bytes；为 source 精确前缀 |
| 连续快照 2 | backup `123,060,226` bytes；为 source 精确前缀 |
| 连续快照 3 | backup `123,164,007` bytes；为 source 精确前缀 |
| CLI freshness | `fresh`，观测 lag 约 4.5 秒 |
| CLI resolve | `matched: true`；`ambiguous: false` |
| 正常退出 | 最终复验在按键后约 1 秒退出；候选进程全部结束 |

三次字节比较都在已打开的稳定文件描述符上完成，source 只允许尾部继续增长；因此结果证明 backup 没有截断、重排或改写已提交前缀。

## 复验中新发现的并发缺陷

首次候选回放出现两个 `SESSION_SYNC_FAILED`：两个实时同步共享同一 worker，大文件 A 完成后调用取消式 `close()` 回收解析隔离区，连带取消已排队的大文件 B。协调器随后把 B 的 generation 记为完成，存在丢失一次实时更新的风险。

修复将两种生命周期语义明确分开，并允许关机升级回收语义：

- `close()`：应用关闭时协作取消待处理任务；
- `retire()`：停止接收新任务，等待已经接收的兄弟任务全部到达回复边界，再关闭 worker。
- 若 `retire()` 已经开始而应用随后关闭，`close()` 会升级现有回收，向已接收任务发送协作取消信号，不再等待大解析自然结束。

大源回收改用 `retire()`，并通过确定性测试验证“先完成 A、开始回收、B 仍成功、回收完成后拒绝新任务”；第二个测试验证“回收期间 close 可在 500ms 门槛内协作取消”。修复后的 real-Library 运行未再产生同类 `SESSION_SYNC_FAILED`，最终正常退出实测约 1 秒。

## 证据清单

私有隔离区（不进 Git）包含：

- 写前 manifest/source/transcript/backup 元数据清单；
- 原 writer owner 文件与哈希；
- dry-run 候选与校验结果；
- apply 前快照及机器可读恢复审计；
- 被隔离的原 writer 锁目录。

本仓库仅归档本 README。一次性真实数据恢复脚本继续留在恢复分支，不并入产品代码。

## 验收状态

| 验收项 | 状态 |
| --- | --- |
| 死亡锁安全隔离 | 通过 |
| 12 个唯一绑定会话补数 | 通过 |
| 3 组历史歧义保持只读 | 通过 |
| 新增消息 60 秒内进入 transcript/backup | 通过 |
| 完整 UUID CLI resolve | 通过 |
| 并发大源回收不丢兄弟同步 | 通过 |
| 全库初始化最终健康状态 | 冻结复验中；性能增量化归 t194 |
