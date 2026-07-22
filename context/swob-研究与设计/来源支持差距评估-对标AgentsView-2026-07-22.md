# 来源支持差距评估：对标 AgentsView

> 日期：2026-07-22
> 性质：纯调研，不含产品代码改动
> Swob 基线：[`e02aebfa0e3f4f2a8dcde2d954d2a1a10be60b6d`](https://github.com/IvyYang1999/swob/tree/e02aebfa0e3f4f2a8dcde2d954d2a1a10be60b6d)
> AgentsView 基线：[`75b9e8bdc8b9c831710afb89a0f414bfd1a8fd23`](https://github.com/kenn-io/agentsview/tree/75b9e8bdc8b9c831710afb89a0f414bfd1a8fd23)（2026-07-22）
> 补充上游证据：Cline [`045518d19fcc7651f1b9c8c18ff8b2f64a0ab066`](https://github.com/cline/cline/tree/045518d19fcc7651f1b9c8c18ff8b2f64a0ab066)、Goose [`bc6161db0e1e513199b38e6d6cb9ea55d9b209fa`](https://github.com/block/goose/tree/bc6161db0e1e513199b38e6d6cb9ea55d9b209fa)

## 一、结论先行

1. **Swob 现在不是“11 个来源都已支持”**。能力真相仍是 5 个 native（Claude Code、Codex、Cursor、OpenCode、ZCode）+ 1 个 Claude 兼容来源（CC-Mirror）+ 5 个 detection-only（Antigravity、Grok、Pi、Kimi、Hermes）。后 5 个只能被发现，不能读正文、搜索或归档进 Vault。依据是 Swob 的 [11 项闭集与定义](https://github.com/IvyYang1999/swob/blob/e02aebfa0e3f4f2a8dcde2d954d2a1a10be60b6d/src/shared/provider-capabilities.ts#L9-L20)及 [detection-only 能力模板](https://github.com/IvyYang1999/swob/blob/e02aebfa0e3f4f2a8dcde2d954d2a1a10be60b6d/src/shared/provider-capabilities.ts#L114-L145)。
2. **AgentsView 固定提交注册的是 53 个来源，不含独立的 Cline 或 Goose**。完整枚举见 [`types.go:L13-L65`](https://github.com/kenn-io/agentsview/blob/75b9e8bdc8b9c831710afb89a0f414bfd1a8fd23/internal/parser/types.go#L13-L65)，工厂 switch 也没有二者，见 [`provider.go:L410-L520`](https://github.com/kenn-io/agentsview/blob/75b9e8bdc8b9c831710afb89a0f414bfd1a8fd23/internal/parser/provider.go#L410-L520)。RooCode parser 兼容部分旧 Roo/Cline 消息形状，不等于 Cline 来源支持；Goose 则没有任何对应 parser。任务书中“AgentsView 支持 Cline、Goose”的前提不成立。本报告仍把二者作为高价值新来源评估。
3. **最大的共用缺口不是某个 parser，而是 Provider Protocol 尚未接入运行时。** t132 已有语言中立 schema、校验器和合成 fixture，但生产 `src/main` 除能力类型外没有消费 `ProviderEnvelope`/`ParseOutcome` 的宿主。当前搜索仍接收 `RawJsonlMessage[]`，Library/Vault 归档仍按旧 `SessionSource` 和物理路径白名单执行。因此应先做一次“Provider canonical graph → 搜索 + Library”的 P0 桥接，再批量加来源；否则每个 parser 都会被迫回接旧 switch，推翻 t132 的设计目的。
4. **“达到 AgentsView 水平”不能解释为强行填满 model/token。** Cursor、Amp、Aider 等被消费的源格式没有权威 token；Amp 也没有权威 model。正确验收是：上游有字段就无损解析并标 `reported`；只有推导值才标 `derived/estimated`；源里没有就明确 `unavailable`，绝不填 0 或猜模型。t132 已规定 usage 不可用时所有数值必须为 `null`，见 [`UsageRecord:L450-L500`](https://github.com/IvyYang1999/swob/blob/e02aebfa0e3f4f2a8dcde2d954d2a1a10be60b6d/schema/provider-protocol-v1.schema.json#L450-L500)。
5. **最短可靠路线**：P0 运行时桥接 → 先补现有 Claude/Codex/Cursor/OpenCode/ZCode/CC-Mirror 的真实性缺口 → 并行落 Gemini、Pi → 再做 RooCode/Aider → 最后逐个攻克 Cline、Goose、Windsurf、Antigravity、Hermes 等复合/SQLite/闭源格式。不能把 53 个名称直接变成一个“大一统 parser”任务。

## 二、口径、证据与工作量

### 2.1 能力口径

逐来源用以下维度核对：

- `D`：发现与稳定来源身份；
- `T`：正文与角色顺序；
- `Tool`：结构化 tool call/result，而非把工具日志当普通文本；
- `M/U`：模型与 usage（token/cache/reasoning/cost，按源实际字段）；
- `R`：父子、fork、continuation、subagent 等关系；
- `I`：真正的 append 增量解析。仅监听文件变化、随后全量重读不算增量；
- `S/V`：进入 Swob 搜索与 Vault/Library。

本报告把“能读正文 + 工具/模型/token + 搜索 + 进 Vault”定义为：

1. 正文和工具若源格式存在，必须结构化保真；
2. model/token 若源格式不存在，必须有 fixture 或上游源码证明并返回 `unavailable`；
3. 解析结果可进入全文搜索；
4. Library host 能为该逻辑会话创建稳定 package，保存规范化记录和来源 provenance；
5. 重扫不重复创建会话，源删除/截断有 replace/tombstone 语义；
6. 增量仅在 append-only 且有可靠边界时要求。AgentsView 自己也只有少数来源声明真正增量。

### 2.2 AgentsView 证据强度

AgentsView 的能力声明模型在 [`capabilities.go:L15-L63`](https://github.com/kenn-io/agentsview/blob/75b9e8bdc8b9c831710afb89a0f414bfd1a8fd23/internal/parser/capabilities.go#L15-L63)，Provider 接口在 [`provider.go:L69-L94`](https://github.com/kenn-io/agentsview/blob/75b9e8bdc8b9c831710afb89a0f414bfd1a8fd23/internal/parser/provider.go#L69-L94)。本报告以“parser 实现 + 测试/fixture + 能力声明”交叉确认，而不盲信声明：

- Aider provider 声明 tool/usage 支持，但实际 fixture 测试明确把 `> ...` 工具行作为 assistant 文本，Markdown 也没有 token，见 [`aider_test.go:L69-L93`](https://github.com/kenn-io/agentsview/blob/75b9e8bdc8b9c831710afb89a0f414bfd1a8fd23/internal/parser/aider_test.go#L69-L93)及 [格式库存 `L1028-L1044`](https://github.com/kenn-io/agentsview/blob/75b9e8bdc8b9c831710afb89a0f414bfd1a8fd23/docs/internal/session-format-sources.md#L1028-L1044)。因此本报告按“正文可读、工具仅文本、usage 不可用”评价。
- Kimi 的 provider 能力表未声明 usage/model，但 parser 与测试已解析当前 wire 的 per-message model/token，并为旧聚合记录生成估算 usage，见 [`kimi_test.go:L262-L310`](https://github.com/kenn-io/agentsview/blob/75b9e8bdc8b9c831710afb89a0f414bfd1a8fd23/internal/parser/kimi_test.go#L262-L310)。因此按实际实现评价，同时把默认模型估算列为风险。

### 2.3 工作量定义与假设

- **S：<1 天**：单一已知格式，小范围映射/测试；
- **M：1–3 天**：一个完整来源，需 discovery、parser、合成 fixture、搜索和 Vault 验证；
- **L：>3 天**：多代格式、复合目录/SQLite、闭源逆向、关系图或真机样本不足。

逐来源工时**假设 P0 运行时桥接已完成**，且包含该来源的 parser、fixture、能力注册、搜索、Vault 和基本回归，不含跨平台实机矩阵。P0 本身为 **L**。如果不先做 P0，下面每项都至少再增加一段重复的主进程/Library 改造，估算失去可比性。

## 三、Swob 当前 11 来源逐项差距

### 3.1 矩阵

| 来源 | AgentsView 实际水平（固定提交） | Swob 真相 | 达标工作、工作量与依据 | 主要风险 |
|---|---|---|---|---|
| Claude Code | `D/T/Tool/M/U/R/I` 全；含 thinking、subagent、per-message usage/model，真正 append 增量。parser/caps：[`claude_provider.go:L534-L565`](https://github.com/kenn-io/agentsview/blob/75b9e8bdc8b9c831710afb89a0f414bfd1a8fd23/internal/parser/claude_provider.go#L534-L565)；fixture：[`claude_provider_test.go:L177-L253`](https://github.com/kenn-io/agentsview/blob/75b9e8bdc8b9c831710afb89a0f414bfd1a8fd23/internal/parser/claude_provider_test.go#L177-L253)。 | native；正文、工具、usage、关系、subagent、watch、搜索、归档可用；thinking 与 format provenance 不可用，见 [`provider-capabilities.ts:L171-L189`](https://github.com/IvyYang1999/swob/blob/e02aebfa0e3f4f2a8dcde2d954d2a1a10be60b6d/src/shared/provider-capabilities.ts#L171-L189)。 | 保留 thinking 内容并进入 canonical message；为 model/usage/provenance 加来源 fixture 与断言；验证截断/replace。**M**：loader 已成熟，但会触及详情、转录、搜索和协议记录，不是单字段补丁。 | Claude JSONL 字段随客户端迭代；thinking 可能为空、加密或受设置影响；不可把可搜索的 raw thinking 等同于详情已保真。 |
| Codex | `D/T/Tool/M/U/R/I` 全；thinking、tool-result event、关系/subagent、真正增量，见 [`codex_provider.go:L756-L786`](https://github.com/kenn-io/agentsview/blob/75b9e8bdc8b9c831710afb89a0f414bfd1a8fd23/internal/parser/codex_provider.go#L756-L786)；增量 fixture：[`codex_provider_test.go:L704-L794`](https://github.com/kenn-io/agentsview/blob/75b9e8bdc8b9c831710afb89a0f414bfd1a8fd23/internal/parser/codex_provider_test.go#L704-L794)。 | native；正文、工具、usage、关系、subagent、watch、搜索、归档和 resume 可用；reasoning 未保留、provenance 不可用，见 [`L191-L201`](https://github.com/IvyYang1999/swob/blob/e02aebfa0e3f4f2a8dcde2d954d2a1a10be60b6d/src/shared/provider-capabilities.ts#L191-L201)。 | 规范化 reasoning；确保 tool call/result ID 和 per-message model/usage 不因旧 `RawJsonlMessage` 投影丢失；补 append/truncate/replace 协议测试。**M**：已有 loader，主要是保真与 canonical 接口。 | rollout 事件代际与 item 类型继续增加；同秒事件、截断和归档目录可能破坏仅按 size 的增量假设。 |
| Cursor | `D/T/Tool`，含 thinking/tool result；无可靠 M/U/R/I，见 [`cursor_provider.go:L589-L608`](https://github.com/kenn-io/agentsview/blob/75b9e8bdc8b9c831710afb89a0f414bfd1a8fd23/internal/parser/cursor_provider.go#L589-L608)；fixture：[`cursor_provider_test.go:L163-L199`](https://github.com/kenn-io/agentsview/blob/75b9e8bdc8b9c831710afb89a0f414bfd1a8fd23/internal/parser/cursor_provider_test.go#L163-L199)。 | native；正文、工具、watch、归档可用；搜索 experimental；thinking、usage、关系、subagent 不可用，见 [`L203-L213`](https://github.com/IvyYang1999/swob/blob/e02aebfa0e3f4f2a8dcde2d954d2a1a10be60b6d/src/shared/provider-capabilities.ts#L203-L213)。 | 补 thinking/tool-result 保真；把搜索从 experimental 提升需 fixture parity；对 model/token 以“源未提供”为 `unavailable`，不能虚构；覆盖 legacy text 与 JSONL。**M**：现有 loader 可用，但源格式无公开 schema且需要两代 fixture。 | Cursor 仅有存储位置文档，无公开 transcript schema；Markdown 角色边界是重建，格式漂移风险高。 |
| OpenCode | `D/T/Tool-call/M/U/R`；thinking、结构化 tool call、per-message usage/model、关系；能力表未声明 tool result；支持当前 SQLite 与旧 storage tree；监听后全量重读，无 I，见 [`opencode_provider.go:L837-L860`](https://github.com/kenn-io/agentsview/blob/75b9e8bdc8b9c831710afb89a0f414bfd1a8fd23/internal/parser/opencode_provider.go#L837-L860)；SQLite/WAL fixture：[`opencode_provider_test.go:L262-L329`](https://github.com/kenn-io/agentsview/blob/75b9e8bdc8b9c831710afb89a0f414bfd1a8fd23/internal/parser/opencode_provider_test.go#L262-L329)。 | native；正文、工具、usage、归档可用；搜索 experimental；thinking、关系/subagent、watch 不可用，见 [`L215-L225`](https://github.com/IvyYang1999/swob/blob/e02aebfa0e3f4f2a8dcde2d954d2a1a10be60b6d/src/shared/provider-capabilities.ts#L215-L225)。 | 解析 thinking/关系；审计并补齐 tool-result 配对；支持 SQLite WAL 安全快照和 legacy tree；注册 watcher；搜索 parity；canonical usage/model。**L**：两代物理格式 + live DB + 关系，不是现有 SQLite 查询的小改。 | OpenCode schema/migration活跃；同族 forks 不必同步；读取 live WAL 时必须保持一致快照。 |
| ZCode | `D/T/Tool/M/U`；thinking、tool result、aggregate usage/model；DB 变更后全量重读，无 R/I，见 [`zcode.go:L51-L64`](https://github.com/kenn-io/agentsview/blob/75b9e8bdc8b9c831710afb89a0f414bfd1a8fd23/internal/parser/zcode.go#L51-L64)；fixture：[`zcode_test.go:L219-L310`](https://github.com/kenn-io/agentsview/blob/75b9e8bdc8b9c831710afb89a0f414bfd1a8fd23/internal/parser/zcode_test.go#L219-L310)。 | native；正文、工具、usage、归档可用；搜索 experimental；thinking、关系/subagent/watch 不可用，见 [`L227-L237`](https://github.com/IvyYang1999/swob/blob/e02aebfa0e3f4f2a8dcde2d954d2a1a10be60b6d/src/shared/provider-capabilities.ts#L227-L237)。 | 保留 thinking 和 tool-result；补 DB watcher/全量 replace、model/usage provenance、搜索 parity。**M**：单 DB schema 且已有 loader；共享 SQLite 快照设施后可控。 | 无公开稳定 schema；usage 表可能缺失，必须返回部分可用而不是整会话失败；workspace deep link 不等于 session resume。 |
| CC-Mirror | **AgentsView 无此来源**；53 项枚举和工厂均无 `cc-mirror`。可参考其 Claude/OpenClaude parser，但不是竞品已验证的 CC-Mirror 支持。 | compatible；正文、工具、usage、搜索可用；关系/subagent/resume experimental；watch、archive、thinking、provenance 不可用，见 [`L239-L262`](https://github.com/IvyYang1999/swob/blob/e02aebfa0e3f4f2a8dcde2d954d2a1a10be60b6d/src/shared/provider-capabilities.ts#L239-L262)。 | 采集 mirror 专属 fixture；把路径纳入安全 discovery/watch 与 archive；验证 lineage 与 config root；补 provenance。**M**：正文复用 Claude，但路径、归档和身份尚未审计。 | “Claude 兼容”不保证 sidecar、子代理目录、配置根和版本完全兼容；未经独立 fixture 不能把 Claude 测试外推。 |
| Antigravity | `D/T/Tool/M/U`；thinking、tool results、per-message + aggregate usage/model；变化后 full replace，无 R/I，见 [`antigravity_provider.go:L483-L497`](https://github.com/kenn-io/agentsview/blob/75b9e8bdc8b9c831710afb89a0f414bfd1a8fd23/internal/parser/antigravity_provider.go#L483-L497)；复合输入 fixture：[`antigravity_provider_test.go:L65-L109`](https://github.com/kenn-io/agentsview/blob/75b9e8bdc8b9c831710afb89a0f414bfd1a8fd23/internal/parser/antigravity_provider_test.go#L65-L109)。 | detection-only；仅 path/占位摘要，正文、工具、usage、搜索、归档全部不可用，见 [`L264-L268`](https://github.com/IvyYang1999/swob/blob/e02aebfa0e3f4f2a8dcde2d954d2a1a10be60b6d/src/shared/provider-capabilities.ts#L264-L268)。 | `conversations` + `brain` + `annotations` 复合 SourceRef；解析正文/工具/thinking/usage/model；fingerprint 全部 side input；搜索/Vault full replace。**L**：复合目录、多变 observed format、桌面与 CLI 还不同。 | 无权威稳定 schema；sidecar 缺失/延迟写入；AgentsView 的 fixture 不能证明所有版本。需真机样本。 |
| Grok / Factory | `D/T/U`；正文、标题、aggregate usage；无结构化 Tool/M/R/I 声明，见 [`grok_provider.go:L228-L238`](https://github.com/kenn-io/agentsview/blob/75b9e8bdc8b9c831710afb89a0f414bfd1a8fd23/internal/parser/grok_provider.go#L228-L238)；golden fixture：[`grok_test.go:L35-L101`](https://github.com/kenn-io/agentsview/blob/75b9e8bdc8b9c831710afb89a0f414bfd1a8fd23/internal/parser/grok_test.go#L35-L101)。 | detection-only；正文到 Vault 全不可用。 | 建 provider、解析多代 transcript 和 aggregate usage；工具/model 若样本无权威字段则明确 unavailable；搜索/Vault。**L**：闭源、多代、AgentsView 自己也没有完整来源库存条目。 | “Grok / Factory”命名可能混合不同生产者/代际；raw backend tool call 与展示消息去重复杂；必须有当前版本样本。 |
| Pi | `D/T/Tool/M/U/R`；thinking、tool results、per-message usage/model、关系；监听后全量重读，无真正 I，见 [`pi_provider.go:L286-L300`](https://github.com/kenn-io/agentsview/blob/75b9e8bdc8b9c831710afb89a0f414bfd1a8fd23/internal/parser/pi_provider.go#L286-L300)；fixture：[`pi_test.go:L201-L354`](https://github.com/kenn-io/agentsview/blob/75b9e8bdc8b9c831710afb89a0f414bfd1a8fd23/internal/parser/pi_test.go#L201-L354)。 | detection-only；正文到 Vault 全不可用。 | JSONL provider、thinking/tool pair、model/usage、parent link；搜索/Vault；Pi/OMP 变体用同骨架不同 provider ID。**M**：公开、单文件、AgentsView 有广泛测试；关系与 tool pairing使其超过 S。 | Pi 与 OMP header/子代理扩展不同；不能把同 parser 等同于同格式版本。真实 parent/subagent 样本不足。 |
| Kimi | 实际为 `D/T/Tool/M/U`；支持旧 `.kimi` 与新 `.kimi-code` wire，thinking/tool；当前 wire 有 model/per-message token，旧记录可能只含 aggregate output，并用默认模型做估算；无 R/I。parser：[`kimi.go:L128-L188`](https://github.com/kenn-io/agentsview/blob/75b9e8bdc8b9c831710afb89a0f414bfd1a8fd23/internal/parser/kimi.go#L128-L188)；usage fixture：[`kimi_test.go:L262-L310`](https://github.com/kenn-io/agentsview/blob/75b9e8bdc8b9c831710afb89a0f414bfd1a8fd23/internal/parser/kimi_test.go#L262-L310)。 | detection-only；正文到 Vault 全不可用。 | 两代 discovery/parser；结构化 tool/thinking；只对真实字段标 reported，旧默认模型只能标 estimated；搜索/Vault。**L**：两代 layout、agent 子目录、模型估算语义，且 AgentsView 声明与实现已漂移。 | 旧日志不记录真实 model/input/cache；估算不能用于“精确账单”；新 `.kimi-code` 仍快速演进。需两代 fixture。 |
| Hermes | `D/T/Tool/M/U/R`；支持 current `state.db` 与旧 transcript/archive，thinking、tool results、aggregate usage/model、关系；full replace，无 I，见 [`hermes_provider.go:L861-L884`](https://github.com/kenn-io/agentsview/blob/75b9e8bdc8b9c831710afb89a0f414bfd1a8fd23/internal/parser/hermes_provider.go#L861-L884)；DB + transcript fixture：[`hermes_provider_test.go:L94-L190`](https://github.com/kenn-io/agentsview/blob/75b9e8bdc8b9c831710afb89a0f414bfd1a8fd23/internal/parser/hermes_provider_test.go#L94-L190)。 | detection-only；正文到 Vault 全不可用。 | current state DB 与 legacy JSONL 双 reader；优先级/去重；FTS 不作为 canonical truth；usage/model/parent；搜索/Vault。**L**：双格式、live WAL、archive/profile roots 和去重。 | Hermes 已由 JSONL 迁移 SQLite；AgentsView 固定提交与最新上游仍可能错位；DB 含跨平台消息，采样隐私面较大。 |

### 3.2 现有 11 项的直接决策

- 先把 **Claude、Codex、Cursor、ZCode、CC-Mirror**补到声明与实际一致；这是最小投入、立即减少“支持但丢字段”的债务。
- **OpenCode**不要继续在旧 loader 上叠 case，应作为第一个完整 Provider Protocol DB provider，顺带验证 SQLite SourceRef、replace、搜索和 Vault。
- detection-only 中优先 **Pi**；它是单 JSONL、公开且测试证据最完整。随后做 **Kimi**，但必须区分 reported 与 estimated。
- **Antigravity、Grok、Hermes**都不能只靠 AgentsView 代码判断兼容，必须先收当前真机 fixture；三者均按 L 单独开任务。

## 四、7 个高价值新来源

| 来源 | AgentsView 实际水平与 fixture | Swob 现状 | 达标工作、工作量与依据 | 主要风险 |
|---|---|---|---|---|
| Gemini CLI | `D/T/Tool/M/U`；thinking、tool result、per-message usage/model；JSONL + legacy JSON；无 R/I。caps：[`gemini_provider.go:L509-L531`](https://github.com/kenn-io/agentsview/blob/75b9e8bdc8b9c831710afb89a0f414bfd1a8fd23/internal/parser/gemini_provider.go#L509-L531)；JSON/JSONL fixture：[`gemini_parser_test.go:L78-L177`](https://github.com/kenn-io/agentsview/blob/75b9e8bdc8b9c831710afb89a0f414bfd1a8fd23/internal/parser/gemini_parser_test.go#L78-L177)。上游与 token 字段证据见 [格式库存 `L163-L179`](https://github.com/kenn-io/agentsview/blob/75b9e8bdc8b9c831710afb89a0f414bfd1a8fd23/docs/internal/session-format-sources.md#L163-L179)。 | 不在 11 项 registry；无 discovery/loader/search/archive。 | `google/gemini-cli` namespaced provider；project metadata + chat 文件复合 fingerprint；JSONL 与 legacy JSON parser；stream/partial line；usage delta；搜索/Vault。**M**：上游开源且 AgentsView 有 fixture，但要兼容两代。 | streamed/cumulative usage 需去重；project metadata 变化会影响身份；旧 JSON 与 JSONL 不能靠扩展名盲判。 |
| Aider | `D/T`；一个 Markdown 文件 fan-out 多个 run；没有权威 model/token；工具行仅 assistant 文本，不是结构化 Tool；监听后 full parse，无 I。parser：[`aider.go:L18-L45`](https://github.com/kenn-io/agentsview/blob/75b9e8bdc8b9c831710afb89a0f414bfd1a8fd23/internal/parser/aider.go#L18-L45)；真实衍生 fixture：[`aider_test.go:L14-L93`](https://github.com/kenn-io/agentsview/blob/75b9e8bdc8b9c831710afb89a0f414bfd1a8fd23/internal/parser/aider_test.go#L14-L93)。 | 未注册。 | 用户显式配置扫描根；深度/时间/目录数上限；Markdown run 边界和虚拟成员 SourceRef；正文搜索/Vault；model/token/tool 明确 unavailable。**M**：解析简单，但安全 discovery、多 run 稳定 ID 和 archive 不能省。 | `$HOME` 递归会触发 macOS 隐私权限和大量 IO；本地时区、无消息时间戳、Markdown 引用误判；文件早期内容删除会导致 run rekey。 |
| Cline | **AgentsView 无独立 provider/fixture**。其 RooCode parser 把 `ui_messages.json` 标为 `ClineMessage[]` 并定义兼容 shape，见 [`roocode.go:L1-L52`](https://github.com/kenn-io/agentsview/blob/75b9e8bdc8b9c831710afb89a0f414bfd1a8fd23/internal/parser/roocode.go#L1-L52)，库存也只承诺“observed older Roo/Cline message variants”，见 [`L236-L255`](https://github.com/kenn-io/agentsview/blob/75b9e8bdc8b9c831710afb89a0f414bfd1a8fd23/docs/internal/session-format-sources.md#L236-L255)；这不能作为 Cline discovery 证据。最新 Cline 仍有 legacy `globalStorage/tasks/<id>` 的 `api_conversation_history.json`、`ui_messages.json`，见 [官方 `disk.ts:L18-L58`](https://github.com/cline/cline/blob/045518d19fcc7651f1b9c8c18ff8b2f64a0ab066/apps/vscode/src/core/storage/disk.ts#L18-L58)；新 SDK 同时出现 `sessions.db` + `messages_path`，见 [官方 `sqlite-session-store.ts:L21-L53`](https://github.com/cline/cline/blob/045518d19fcc7651f1b9c8c18ff8b2f64a0ab066/sdk/packages/core/src/services/storage/sqlite-session-store.ts#L21-L53)。 | 未注册。 | 先定义支持边界：VS Code legacy、当前 SDK，还是两者；分别实现 composite-directory 与 SQLite-row + message artifact；工具、usage/model、subagent/parent；去重迁移后的同一会话；搜索/Vault。**L**：两个同时存在的存储世代，AgentsView 无可直接复用 provider。 | Cline 正处存储迁移期；`taskHistory.json`、task dir、SDK DB/messages 文件可能并存；只做 RooCode 路径会漏掉 Cline；上游变更频率高。 |
| RooCode | `D/T/Tool/M/U/R`；per-task `history_item.json` + `ui_messages.json`；thinking、tool events、subagent、关系、aggregate usage/model；无 I。caps：[`roocode_provider.go:L165-L183`](https://github.com/kenn-io/agentsview/blob/75b9e8bdc8b9c831710afb89a0f414bfd1a8fd23/internal/parser/roocode_provider.go#L165-L183)；基础 fixture：[`roocode_test.go:L16-L109`](https://github.com/kenn-io/agentsview/blob/75b9e8bdc8b9c831710afb89a0f414bfd1a8fd23/internal/parser/roocode_test.go#L16-L109)；subtask fixture：[`L1125-L1209`](https://github.com/kenn-io/agentsview/blob/75b9e8bdc8b9c831710afb89a0f414bfd1a8fd23/internal/parser/roocode_test.go#L1125-L1209)。 | 未注册。 | composite SourceRef、消息和 metadata 一致 fingerprint；tool pair/reasoning/usage/model；subtask 关系；full replace；搜索/Vault。**L**：单代目录清楚，但 tool pairing、子任务与累计 usage 的端到端验收超过 3 天的安全边界。 | AgentsView registry 注释称 RooCode 已在 2026-05-15 停止、ZooCode 为活跃 fork，见 [`types.go:L742-L764`](https://github.com/kenn-io/agentsview/blob/75b9e8bdc8b9c831710afb89a0f414bfd1a8fd23/internal/parser/types.go#L742-L764)；需决定支持历史 Roo 还是活跃 fork，两者不可默认为同格式。 |
| Windsurf | `D/T/Tool/M/U` 声明；thinking、tool results、aggregate usage/model；`state.vscdb` virtual session，full replace，无 R/I。caps：[`windsurf_provider.go:L925-L949`](https://github.com/kenn-io/agentsview/blob/75b9e8bdc8b9c831710afb89a0f414bfd1a8fd23/internal/parser/windsurf_provider.go#L925-L949)；SQLite fixture：[`windsurf_provider_test.go:L18-L60`](https://github.com/kenn-io/agentsview/blob/75b9e8bdc8b9c831710afb89a0f414bfd1a8fd23/internal/parser/windsurf_provider_test.go#L18-L60)。但其格式库存又说明被消费状态无可靠 token/USD，见 [`L331-L352`](https://github.com/kenn-io/agentsview/blob/75b9e8bdc8b9c831710afb89a0f414bfd1a8fd23/docs/internal/session-format-sources.md#L331-L352)；故 M/U 必须用真实 fixture 再确认，不能照抄能力声明。 | 未注册。 | VS Code workspace discovery；只读 SQLite 一致快照；按 DB row/JSON 内 virtual session 建稳定 ID；多种 tab/bubble shape；搜索/Vault；usage/model 若无真实字段即 unavailable。**L**：闭源逆向 + live DB + 声明/库存冲突。 | key/value schema 无权威来源；Windsurf Next 与正式版路径不同；复制 DB 可能漏 WAL；fixture 可能混入工作区与账号状态。 |
| Amp | `D/T/Tool`；thinking、tool results；单 JSON thread；无 M/U/R/I。caps：[`amp_provider.go:L53-L62`](https://github.com/kenn-io/agentsview/blob/75b9e8bdc8b9c831710afb89a0f414bfd1a8fd23/internal/parser/amp_provider.go#L53-L62)；tool/thinking fixture：[`amp_test.go:L56-L159`](https://github.com/kenn-io/agentsview/blob/75b9e8bdc8b9c831710afb89a0f414bfd1a8fd23/internal/parser/amp_test.go#L56-L159)。库存明确无公开 schema与 usage，见 [`L302-L312`](https://github.com/kenn-io/agentsview/blob/75b9e8bdc8b9c831710afb89a0f414bfd1a8fd23/docs/internal/session-format-sources.md#L302-L312)。 | 未注册。 | JSON thread discovery/parser；trace → message/tool/thinking；搜索/Vault；M/U/R 明确 unavailable。**M**：单文件，但闭源格式与错误/缺字段分支需要真机 fixture。 | 无公开 producer/schema；thread shape 只能由样本维护；标题/env/traces 可缺失；不能从产品计费页面反推 transcript token。 |
| Goose | **AgentsView 无 provider/fixture**。最新 Goose 官方存储为 WAL SQLite `sessions/sessions.db`，见 [`session_manager.rs:L24-L28`](https://github.com/block/goose/blob/bc6161db0e1e513199b38e6d6cb9ea55d9b209fa/crates/goose/src/session/session_manager.rs#L24-L28)及 [`L845-L868`](https://github.com/block/goose/blob/bc6161db0e1e513199b38e6d6cb9ea55d9b209fa/crates/goose/src/session/session_manager.rs#L845-L868)。schema v15 的 sessions/messages/usage_ledger 含 parent、model config、tokens、消息 content JSON，见 [`L925-L1000`](https://github.com/block/goose/blob/bc6161db0e1e513199b38e6d6cb9ea55d9b209fa/crates/goose/src/session/session_manager.rs#L925-L1000)；官方内存库 test 可作上游行为证据，见 [`L2950-L3013`](https://github.com/block/goose/blob/bc6161db0e1e513199b38e6d6cb9ea55d9b209fa/crates/goose/src/session/session_manager.rs#L2950-L3013)，但不是 AgentsView fixture。 | 未注册。 | SQLite-row provider；messages `content_json` 中解析 text/thinking/tool；sessions/usage_ledger 解析 model/token/cost/parent；WAL 快照、schema version/migration、full replace、搜索/Vault。**L**：公开 schema降低逆向风险，但内容 union、15 版 migration、live DB和 parent/subagent 仍复杂。 | 没有 AgentsView 可复用实现；Goose 自身会导入 legacy sessions，需避免二次重复；DB 中有多种 SessionType；usage 当前值与 accumulated/ledger 需定唯一真相。 |

## 五、AgentsView 其余 registry：按格式族而非逐名称复制

下表覆盖固定提交的全部 53 项；Cline、Goose 不在其中。分组表示可共享的**来源基础设施**，不表示字段 schema 完全相同。

| 格式族 | AgentsView registry 来源 | Swob 可共享骨架 | 不应错误合并的边界 |
|---|---|---|---|
| append/line-oriented 单文件 | Claude、OpenClaude、Codex、Copilot、Cursor、Pi、OMP、Qwen、CommandCode、DeepSeek TUI、OpenClaw、QClaw、Kimi、Kiro CLI、Cortex、Grok、WorkBuddy、gptme、Qoder、Mistral Vibe | 安全 line reader、partial-tail、content hash、append cursor、truncate → replace、通用 file SourceRef | 只有 Claude/Codex 等已证明 append-safe；JSONL 只是容器，不代表事件/usage/关系相同。 |
| JSON/复合目录/sidecar | Cowork、Gemini、OpenHands、Amp、Zencoder、iFlow、Kiro IDE、Hermes、Antigravity、Antigravity CLI、QwenPaw、Reasonix、Posit Assistant、RooCode | composite-directory SourceRef、成员 fingerprint、缺失成员的 partial error、原子快照、full replace | task-dir、event-dir、DB+transcript、sidecar 的权威优先级各异；不能用一个 JSON decoder 处理。 |
| OpenCode family storage tree/SQLite | MiMoCode、OpenCode、Kilo、IcodeMate | session/message/part 读取、legacy tree 与 SQLite 双 reader、usage/model mapper、fork provider ID | 每个 fork 的 migration、DB 名、usage/cost语义需独立 fixture；共享 parser 不等于共享版本承诺。 |
| IDE/SQLite/state store | VSCode Copilot、Windsurf、Trae、Visual Studio Copilot、Positron、ZCode、Zed、Shelley | SQLite/WAL snapshot、virtual row SourceRef、workspace metadata、force-replace、只归档会话行而非整库 | VS Code `state.vscdb`、产品自有 DB、trace log 完全不同；只共享 DB 访问层。 |
| native app DB/API/封装容器 | Forge、Devin、Piebald、Warp | app-specific discovery、import/package adapter、非文件 SourceRef | `FileBased:false` 不代表同一存储；每项需独立平台与版本取证。 |
| 用户导出包 | Claude.ai、ChatGPT | import-package SourceRef、zip path containment、重复导入 identity、静态 archive | 导出 schema 与本地 live source 生命周期不同，不应挂 watcher。 |
| Markdown 多会话 | Aider | bounded scan、virtual-member、低保真角色重建 | 不能声称结构化 tool/model/token；Markdown 是展示历史，不是 API event log。 |

名单数量复核：20 + 14 + 4 + 8 + 4 + 2 + 1 = **53**，与 [`Registry:L103-L105`](https://github.com/kenn-io/agentsview/blob/75b9e8bdc8b9c831710afb89a0f414bfd1a8fd23/internal/parser/types.go#L103-L105)及末项 [`L742-L765`](https://github.com/kenn-io/agentsview/blob/75b9e8bdc8b9c831710afb89a0f414bfd1a8fd23/internal/parser/types.go#L742-L765)一致。

## 六、实施路线：可直接拆任务

### P0：Provider 运行时宿主与两个下游投影（L，所有新来源前置）

**事实依据**：

- t132 已覆盖 file、composite-directory、sqlite-row、virtual-member、import-package，见 [`schema:L217-L299`](https://github.com/IvyYang1999/swob/blob/e02aebfa0e3f4f2a8dcde2d954d2a1a10be60b6d/schema/provider-protocol-v1.schema.json#L217-L299)；不需要为 Gemini/Roo/Goose 再造 SourceRef。
- t132 明确 Provider 只报告来源事实，**不写 Vault**；Library host 决定 logical identity/package，见 [`schema/README.md:L21-L37`](https://github.com/IvyYang1999/swob/blob/e02aebfa0e3f4f2a8dcde2d954d2a1a10be60b6d/schema/README.md#L21-L37)。
- 新 namespaced provider 不必加入旧闭集 `LEGACY_SESSION_SOURCES`，见 [`schema/README.md:L39-L47`](https://github.com/IvyYang1999/swob/blob/e02aebfa0e3f4f2a8dcde2d954d2a1a10be60b6d/schema/README.md#L39-L47)。
- 当前 validator 只提供 decode/validate/conformance，见 [`provider-protocol.ts:L387-L446`](https://github.com/IvyYang1999/swob/blob/e02aebfa0e3f4f2a8dcde2d954d2a1a10be60b6d/src/shared/provider-protocol.ts#L387-L446)；生产 `src/main` 尚无 envelope consumer。
- 搜索入口仍把来源变成 `RawJsonlMessage[]`，见 [`search-index.ts:L276-L317`](https://github.com/IvyYang1999/swob/blob/e02aebfa0e3f4f2a8dcde2d954d2a1a10be60b6d/src/main/search-index.ts#L276-L317)。Library 仅把 Claude/Codex/Cursor 认作可物理备份来源，见 [`library-manager.ts:L262-L276`](https://github.com/IvyYang1999/swob/blob/e02aebfa0e3f4f2a8dcde2d954d2a1a10be60b6d/src/main/library-manager.ts#L262-L276)；`syncBackup` 继续复制/拼接旧 source file，见 [`L2865-L2914`](https://github.com/IvyYang1999/swob/blob/e02aebfa0e3f4f2a8dcde2d954d2a1a10be60b6d/src/main/library-manager.ts#L2865-L2914)。

**P0 任务边界**：

1. Provider host：加载内建/sidecar manifest，hello 握手，调用 discover/fingerprint/parse，所有 envelope 先过 t132 validator；超时、资源限制、取消、崩溃均 typed error。
2. Canonical session store（运行时）：保留 session/message/tool-call/tool-result/usage/relationship/provenance，不把它永久压扁成 Claude 风格 JSONL。
3. 搜索投影：新增 canonical indexer，把 text、thinking（按隐私设置）、tool name/input/result写入 FTS；支持 source/session/project 过滤、replace/tombstone。现有 `indexParsedSearchSource` 可作为过渡，但不能成为新的协议真相。
4. Library/Vault 投影：Library host 用 canonical records 创建 package；为新 provider 保存确定性规范化记录 + provenance。SQLite 来源只归档该会话的规范化记录，不默认复制含其他会话/账号状态的整库。原始 source artifact 是否备份应按 provider 和用户设置决定。
5. 稳定身份：`providerId + sourceRef.stableId + canonical session id` 映射到 `LogicalSessionIdentity`；重扫、移动目录、远程 canonical path 和 multi-session fan-out 都要测。
6. full replace/tombstone：JSON/复合目录/DB 默认 fingerprint 后全量 replace；只有 append-safe 来源启用增量。t132 已有 complete/partial/replace/no-data/tombstone 语义，见 [`schema:L616-L747`](https://github.com/IvyYang1999/swob/blob/e02aebfa0e3f4f2a8dcde2d954d2a1a10be60b6d/schema/provider-protocol-v1.schema.json#L616-L747)。

**P0 验收 fixture**：一个单文件 provider、一个复合目录 provider、一个 SQLite-row provider；三者均跑 discover → parse → search → archive → reload → source update → replace/tombstone，不依赖任何真实私密 transcript。

### 批次 1：现有高成熟度来源纠偏（1 单，L）

- Claude + Codex：thinking、tool-result/model/usage/provenance、append/截断；
- Cursor：thinking/tool-result与搜索 parity，明确 token unavailable；
- ZCode：thinking/model/usage、DB replace、搜索；
- CC-Mirror：路径/watch/archive/provenance。

为什么能捎带：都有现有 loader 和 UI 链路，主要验证 canonical adapter。OpenCode 不捎带，因为它应成为完整 DB provider 的样板。

### 批次 2：公开单文件/记录格式（2 单）

1. **Pi + OMP 骨架（M）**：同 parser family，provider ID/path/header 分开；先完成 Pi，OMP 作为追加 fixture。
2. **Gemini CLI（M）**：单独一单，覆盖 JSONL + legacy JSON、stream partial、usage delta、project metadata。

Kimi 不放入此批：它有两代 wire、agent 目录与估算 usage，按 L 单独做。

### 批次 3：OpenCode family（1 平台单 + 若干小来源单）

- **OpenCode Provider（L）**：P0 后第一个 SQLite/legacy tree 完整样板；
- **Kilo + MiMoCode + IcodeMate（L，后续一单）**：共享基础 reader，但每个 fork 独立 format version/fixture/capability；
- **ZCode 不并入 parser**：只共享 SQLite snapshot/SourceRef 工具。

### 批次 4：多会话与 task-directory（3 单）

1. Aider（M）：bounded discovery + virtual member；
2. RooCode（L）：composite + tool/subtask/usage；
3. Cline（L）：先写支持边界 ADR，再实现 legacy task-dir 和/或新 SDK DB；不能把 RooCode provider 改名复用。

### 批次 5：复杂 DB/闭源来源（每项独立）

- Goose（L）：官方 schema 清楚，但 migration/content/usage/parent复杂；
- Hermes（L）：current DB + legacy transcript；
- Windsurf（L）：闭源 state.vscdb；
- Antigravity（L）：复合 sidecar；
- Kimi（L）：双代 wire；
- Grok（L）：闭源多代；
- Amp（M）：单 JSON、能力较窄。

这些来源只共享 DB snapshot、composite fingerprint、JSON union 等库，不共享业务 parser。把它们塞进一单会让 fixture、能力声明和回归责任无法验收。

### 批次 6：53 项长尾

按第五节格式族开 epic；每个来源进入开发前必须有：上游固定 commit/版本、最小脱敏 fixture、期望能力表、缺失字段证明、跨平台路径、归档策略。优先级由真实用户安装量和 fixture 可得性排序，而不是按 registry 顺序。

## 七、MIT 引用/移植判断

AgentsView 固定提交为 MIT，许可允许使用、修改和再发布，但复制或实质衍生部分必须保留版权与许可通知，见 [`LICENSE:L1-L20`](https://github.com/kenn-io/agentsview/blob/75b9e8bdc8b9c831710afb89a0f414bfd1a8fd23/LICENSE#L1-L20)。本任务**不移植代码或 fixture**。

如果后续执行移植，统一遵守 t131 口径：固定上游 commit；在第三方清单/NOTICE 记录 `Kenn Software LLC / MIT / 文件路径 / commit`；派生文件头或 adjacent notice 标来源；不复制真实 transcript fixture；保留独立的 Swob 合成 fixture与行为测试。

| 来源 | AgentsView Go parser 是否值得引用/移植 | 判断 |
|---|---|---|
| Claude、Codex | 可参考，通常不值得整段移植 | Swob 已有成熟 TS loader；移植重点应是遗漏行为与边界测试，不是平行重写。 |
| Cursor | 谨慎参考 | parser 基于文档/observed Markdown，代码可复用不等于格式权威；优先用 Swob 自有新 fixture验证。 |
| OpenCode、ZCode | **值得**按 MIT 移植解析逻辑/测试思想 | DB/legacy tree、usage/model映射复杂且有开源上游证据；仍需改造成 t132 canonical records，不能照搬 AgentsView数据模型。 |
| CC-Mirror | 无直接实现可移植 | 只能参考 Claude/OpenClaude；mirror 路径与身份必须独立实现。 |
| Antigravity、Grok、Windsurf、Amp | 可参考，但不可作为唯一证据 | 闭源/逆向格式；可移植 parser 逻辑，fixture 必须自行采集，能力缺失必须保守。 |
| Pi | **值得** | 单 JSONL、测试覆盖广、与 OMP 共用骨架；映射到 t132 较直接。 |
| Kimi | 部分值得 | 双代 wire解析有价值；默认模型与费用估算策略不要无审查照搬，Swob 必须标 `estimated`。 |
| Hermes | 值得参考/部分移植 | DB + legacy 优先级/去重有价值；先与 Hermes 当前固定上游比较 schema。 |
| Gemini | **值得** | 公开上游、两代格式、usage delta处理成熟，是移植收益高且合规边界清晰的来源。 |
| Aider | 只值得复用 run/稳定 ID 思路 | AgentsView capability 声明过度；不能移植“结构化 tool/usage 支持”的结论。 |
| RooCode | **值得**，但需重做归档/身份层 | tool pairing、subtask、usage逻辑复杂；移植后仍要针对 Roo/Zoo 支持边界做新 fixture。 |
| Cline、Goose | 无 AgentsView parser可移植 | Cline 只能参考 Roo 旧消息兼容；Goose 应直接依据官方 Apache-2.0 schema独立实现。 |

## 八、与 t132 Provider 契约的具体对接

### 8.1 现有 schema 已足够的部分

- Gemini/Pi/Amp/Claude 等：`FileSourceRef`；
- RooCode/Cline legacy/Antigravity：`CompositeDirectorySourceRef`；
- Goose/Windsurf/Hermes/ZCode/OpenCode：`SqliteRowSourceRef`，必要时 fingerprint inputs 包含 DB/WAL/metadata；
- Aider：物理 Markdown container + `VirtualMemberSourceRef`；
- Claude.ai/ChatGPT：`ImportPackageSourceRef`；
- 正文/thinking/tool/usage/relationship 均已有 canonical record，见 [`MessageRecord` 与 tool records `L351-L449`](https://github.com/IvyYang1999/swob/blob/e02aebfa0e3f4f2a8dcde2d954d2a1a10be60b6d/schema/provider-protocol-v1.schema.json#L351-L449)、[`RelationshipRecord:L504-L522`](https://github.com/IvyYang1999/swob/blob/e02aebfa0e3f4f2a8dcde2d954d2a1a10be60b6d/schema/provider-protocol-v1.schema.json#L504-L522)。

因此，**不要为每个新来源扩展协议 schema**。多数任务只新增 provider manifest、parserDataVersion、formatVersions、capability evidence 和 parser fixture。

### 8.2 需要补的 registry/运行时内容

1. 新来源使用 namespaced ID，例如 `google/gemini-cli`、`aider/aider`、`block/goose`；不要继续扩 `LegacySessionSource` 闭集。
2. 每个 provider manifest 必须声明 discover/transcript/tools/thinking/usage/relationships/subagents/watch/search/archive 的真实状态与证据；未接搜索/Vault前不能先宣称可用。
3. `formatVersions` 不能只写 `observed`：开源 producer 尽量绑定 producer commit/schema version；闭源来源至少记录 app version + fixture format hash + observed date。
4. current 11 项可逐步由 legacy provider adapter 输出 canonical records；迁移完成前保持旧 ID 映射，但不让新来源进入旧 switch。
5. provider parser 不得写 Vault、改用户标签或生成 package ID；这些仍由 Library host持有。

### 8.3 一个协议盲点：model 能力不可单独声明

t132 的 `UsageRecord.model` 能承载模型，但 `ProviderCapabilities` 只有 `usage`，没有独立的 model-attribution 维度。于是“有 model、无 token”或“有 token、无可靠 model”的来源无法仅靠 manifest 说清。

本报告不建议在实现来源时临时改 v1 required capability 对象，因为这会造成 wire/conformance 兼容问题。建议另开 t132 follow-up：

- 短期：每个 provider 增加非 wire 的 conformance case，断言 model 的 `reported/derived/estimated/unavailable` 证据；
- 下一协议版本：评估新增 `model-attribution` capability，或把 usage 拆成 model/quantity/cost provenance；必须走 schema version评审，不在某个来源任务里顺手修改。

## 九、fixture 采集清单：yyt 需要做什么

### 9.1 通用采集动作

对每个已安装 harness，yyt 只需在一个**新建、无真实业务内容**的临时项目中完成下面动作：

1. 记录 harness 名称、版本、OS、采集日期、是否 CLI/IDE、使用的模型显示名；不要记录账号、token、机器 ID。
2. 新建临时目录，放一个仅含 `README.md` 和 `hello.txt` 的仓库；不要在真实 Vault/客户仓库运行。
3. 发两轮合成请求：第一轮要求读取 `hello.txt` 并创建 `result.txt`；第二轮要求运行无敏感输出的命令（如列出临时目录）并总结。若产品支持 thinking、子代理、模型切换，再各触发一次。
4. 等会话正常结束并关闭 harness，避免半写文件。SQLite 来源优先用 `sqlite3 <db> '.backup <staging.db>'` 生成一致备份；不能 backup 时，关闭应用后同时复制 DB、`-wal`、`-shm`（若存在）。
5. 只复制该会话必需文件到 repo 外的私有 staging；记录原相对目录结构和文件名。不要把 raw 样本直接提交 Git。
6. 本地脱敏：用户名/home path → `/Users/example`；项目名 → `fixture-project`；prompt/answer/tool 参数 → 等价合成文本；邮箱、URL、git remote、组织名、文件正文、附件、环境变量、认证 header 全部移除；ID 可稳定替换为同长度假 ID；token 数值可改，但同一 aggregate/delta 关系必须一致。
7. 脱敏后做两次检查：全文搜索原用户名/项目名/email/域名和常见 secret 前缀；再人工打开 JSON/JSONL/Markdown/SQLite 相关行。只有脱敏副本可进入 `testdata`。
8. fixture 提交时附 `README`：来源版本、采集路径模板、覆盖能力、已删字段、哪些值为合成；不写真实机器路径与账号。

### 9.2 立即需要的最小样本

| 来源 | yyt 最小动作与应交文件 | 为什么需要 |
|---|---|---|
| Claude Code | 用当前版本产生一条含 reasoning/thinking、tool call/result、usage/model 的两轮 JSONL；再复制一份截断/继续后的版本。 | 现有缺口是 thinking/provenance/增量边界，不需普通对话样本。 |
| Codex | 当前 rollout JSONL：reasoning、命令 tool、usage/model、一次 resume；保留同一会话的 before/after 两份。 | 验证增量、reasoning、tool-result ID 和 replace。 |
| Cursor | 当前 `agent-transcripts` 会话；若有 legacy text 再各一份；记录 app version。 | 闭源 schema；确认 thinking/tool-result存在及 token确实缺失。 |
| OpenCode | 关闭或 backup 当前 `opencode.db`；另有旧 `storage/{session,message,part}` 安装时提供一组目录；至少一条 parent/fork 与 tool/usage。 | 当前与 legacy 双格式、WAL 和关系。 |
| ZCode | 一份最小 DB backup，包含 tool、thinking、usage/model；再造一份无 usage table 的合成变体由开发者完成。 | 无公开稳定 schema。 |
| CC-Mirror | 一条 mirror 实际 JSONL + 对应相对 config/project/subagent布局，含工具和 usage。 | Claude 兼容并不能证明路径、子代理和归档。 |
| Antigravity | 同一会话的 `conversations` 文件及关联 `brain`、`annotations` 成员；若使用 Antigravity CLI，再给 CLI `history`/implicit sidecar。 | 复合 fingerprint 与 desktop/CLI 差异。 |
| Grok / Factory | `.grok/sessions` 中一条当前会话，覆盖 tool/reasoning/usage；记录到底是 Grok 还是 Factory 产品与版本。 | 当前命名和代际不清，AgentsView仅 observed fixture。 |
| Pi | 一条 session JSONL，含 tool/thinking/model/usage；若能 spawn，再给 parent + child 两文件。 | 单文件好做，但关系需真实样本。 |
| Kimi | 一份旧 `.kimi/.../wire.jsonl` 与一份当前 `.kimi-code/.../wire.jsonl`；两者都触发 tool，当前版保留 model/usage。 | 两代格式与 estimated/reported 边界。 |
| Hermes | 当前 `state.db` 一致 backup，含 tool/model/token/parent；另有旧 archive/transcript 时给同一逻辑会话的 DB+JSONL 对照。 | DB/legacy权威优先级和去重。 |
| Gemini CLI | 当前 JSONL chat + project metadata；若本机仍有 legacy JSON，另给一份；触发 tool、thinking、usage。 | 两代格式和累计/stream usage。 |
| Aider | 一个临时 repo 的 `.aider.chat.history.md`，连续启动两次 Aider形成两个 run，至少一次 edit/tool输出。 | run fan-out、稳定 ID、Markdown误判；无需 token样本。 |
| Cline | **两组优先**：A) VS Code `state/taskHistory.json` + `tasks/<id>/api_conversation_history.json` + `ui_messages.json` + `task_metadata.json`/`settings.json`（存在才给）；B) 新 SDK 的 `sessions.db` backup + 该行 `messages_path` 指向的 messages JSON。 | 最新上游同时有 legacy task-dir 与 SDK DB；必须先决定覆盖世代和去重。 |
| RooCode / ZooCode | 一个完整 `tasks/<id>/` 目录，含 `history_item.json`、`ui_messages.json`；再触发一次 subtask/new_task。明确产品是 RooCode 还是 ZooCode及版本。 | 关系/tool pairing/累计 usage；Roo 与活跃 fork 边界。 |
| Windsurf | 临时 workspace 的 `workspaceStorage/<id>/state.vscdb` 一致 backup + `workspace.json`；触发 tool/thinking；记录正式版还是 Next。 | 闭源 key/value schema，且 AgentsView usage声明冲突。 |
| Amp | 一条当前 thread JSON，含 thinking、tool success、tool error；不需要 token。 | 无公开 schema，必须有当前 app fixture。 |
| Goose | `sessions/sessions.db` 一致 backup，含 root 会话、tool、usage/model；若支持 subagent，再加 parent/child；记录 schema version（当前源码为15）。 | AgentsView无实现；需直接验证官方 schema的实际 content JSON与 ledger。 |

### 9.3 暂不需要 yyt 一次性安装的长尾

其余 38 个 AgentsView registry 项不要为了“凑 53”一次性安装。这里的 38 = 53 - 已逐项核对的 10 个 Swob/AgentsView 重叠来源 - 5 个 AgentsView 新来源；Cline、Goose、CC-Mirror 本就不在 53 项内。先从真实用户已安装来源、开源 producer 的合成 fixture和公开测试入手。只有以下情况再找 yyt：

- 闭源 IDE/state DB：必须当前版本真机样本；
- OS 专属路径/native app DB：必须对应平台；
- provider 声明与 parser/库存冲突；
- 上游公开 schema无法覆盖 tool/usage/关系的真实组合。

## 十、可拆出的后续任务书

| 建议任务 | 产出 | 工作量 | 前置 |
|---|---|---:|---|
| t155-P0 Provider runtime bridge | host、canonical runtime store、search projection、Library projection、3类合成 E2E | L | t132 已合入 |
| t155-B1 existing parity | Claude/Codex/Cursor/ZCode/CC-Mirror capability truth与缺口修复 | L | P0、对应新 fixture |
| t155-B2 Pi/OMP | Pi 完整 provider + OMP variant | M | P0、Pi fixture |
| t155-B3 Gemini | JSONL/legacy JSON provider | M | P0、Gemini fixture |
| t155-B4 OpenCode family core | OpenCode SQLite + legacy tree样板 | L | P0、DB/tree fixture |
| t155-B5 Aider | bounded scan + virtual sessions + search/Vault | M | P0、Aider fixture |
| t155-B6 RooCode | composite、tool、subtask、usage | L | P0、Roo/Zoo边界决定 |
| t155-B7 Cline ADR + provider | 支持世代ADR、legacy/SDK实现与去重 | L | P0、两代 fixture |
| t155-B8 Goose | SQLite schema v15+、content/usage/parent | L | P0、Goose fixture |
| t155-B9 closed/complex queue | Windsurf、Antigravity、Hermes、Kimi、Grok、Amp各独立 | L/M | P0、逐项 fixture |
| t132-model follow-up | model attribution capability/version方案 | M | 不阻塞正文 parser，但阻塞“manifest可审计的model parity” |

## 十一、最终判断

这项工作的本质不是“把 53 个路径塞进 detector”，而是建立一条不会丢语义、不会伪造 usage、能稳定进搜索与 Vault 的来源管线。t132 已经解决了线协议和 canonical 类型；当前最关键的下一步是完成运行时宿主与 Library 所有权边界。P0 完成后，公开单文件来源可稳定以 M 级速度扩展，SQLite/复合/闭源来源仍需按 L 逐项取证。

上线口径建议改成可验证的两层，而不是一句“所有来源都支持”：

1. **核心支持集**：有真实 fixture，正文/工具/usage（若源有）/搜索/Vault E2E 全绿；
2. **registry 长尾**：每项明确 `supported / experimental / detected-only / unavailable` 与证据，不用来源数量替代能力事实。

只有第一层达标的来源才可以在产品文案中称“支持”；第二层仍可持续扩展，但不能以 detector 数量冒充正文支持。
