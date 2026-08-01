# T175A Qoder 格式侦察与能力证据

## 结论

Qoder 当前只能按“独立实现参考 + 合成 fixture”接入，不能宣称已通过第一方
producer schema 或本机真实会话验证。解析器直接生成 Provider Protocol v2 事件；
对未被公开证实的 usage、thinking、compact 与 Resume 保留降级声明，不做 Token
估算，也不把“打开 IDE”算作恢复会话。

## 可复核事实

- 本机在 2026-08-01 未找到 `qoder`、`qodercli`、`Qoder.app`、
  `~/.qoder/projects` 或 `~/.qoderwork/projects`。`~/.qoder` 本身存在，但本次只做
  `stat`，未列目录、未读取账号配置或任何真实会话。
- Qoder 官方文档确认桌面版安装需要下载并登录；CLI 文档公开
  `qodercli -r <session-id>` 与 `/resume`。本次没有安装、登录或执行 Resume，避免
  凭据和私密会话进入任务上下文。
- AgentsView 固定提交
  `1cd581fe34e87e134160c6668deffb674b7eaa4e` 的 Qoder adapter 参考布局为：
  `~/.qoder/projects` / `~/.qoderwork/projects` 下的项目目录、主会话
  `<session-id>.jsonl`、伴随 `<session-id>-session.json`，以及
  `<session-id>/subagents/agent-*.jsonl`。
- 同一固定提交明确写明 `no-public-source`：未找到第一方 producer-side session
  serializer 或权威本地 schema。因此该实现可证明“参考实现如何消费”，不能证明
  “所有 Qoder 版本必然如何生产”。

参考：

- <https://docs.qoder.com/quick-start>
- <https://docs.qoder.com/zh/cli/using-cli>
- <https://github.com/kenn-io/agentsview/tree/1cd581fe34e87e134160c6668deffb674b7eaa4e/internal/parser>

## 八层能力预判

| 层 | 证据等级 | 当前实现与边界 |
|---|---|---|
| 发现 | exact（参考布局） | 严格发现主 JSONL 与嵌套 subagent；sidecar 纳入复合 fingerprint；真实 producer 尚待采样 |
| 元数据 | exact-if-present | 保留 sidecar `title`、`working_dir`、`fork_from`、`parent_session_id`；不补造缺失字段 |
| 消息 | exact-if-present | 按 JSONL 顺序保留 text/thinking/reasoning/unknown；超长已知正文按 UTF-8 边界拆成连续事件，不截断正文；未知事件走 v2 `unknown` |
| 工具 | exact-if-present | 保留 tool call/result 原顺序与 raw name；通过三层工具注册表映射 Read/Write/Edit/Bash |
| 系统 + compact | unavailable | 未发现权威 compact 边界或模型当时上下文；归档时间线存在，但 context state 明确为 `unknown` |
| Token | exact-if-present / unavailable-if-absent | 仅在 v2 透传持久化整数 counter；`input_tokens` 记为 provider total，cache 与 input 的集合关系仍未知；不推导 uncached/cache 加总、不估成本，v1/UI 兼容视图因 provider-defined 关系 fail-closed 为 unavailable |
| 关系 | exact-if-present | sidecar fork/parent 与路径 subagent 形成显式 branch/lifecycle；不猜未持久化关系 |
| Resume | experimental（CLI）/ unavailable（IDE） | 官方文档有 `qodercli -r`，本机无 binary；契约要求 binary/help/source preflight 与恢复后 anchor 校验；IDE 打开任务不计 Resume |

## 合成 fixture

`testdata/qoder/` 只含 Swob 创建的合成 UUID、合成路径和合成文本，覆盖：

- 主会话 JSONL + sidecar 复合 fingerprint；
- text → thinking → text → tool call → usage → tool result 的有序事件；
- fork sidecar、subagent 目录关系与 Bash 工具；
- 未知未来事件透传、搜索 needle、usage 缺失时不造零值。

格式布局受 AgentsView MIT 实现启发，归属与固定提交记录在
`testdata/qoder/NOTICE`。

资源边界也由合成测试固定：每个会话的 transcript + sidecar 合计超过
50 MiB 时在读文件前 fail-closed；每个分片同时满足 1,000 事件上限与
Provider Protocol v2 envelope 字节上限。Opaque unknown/tool JSON 会按
string/depth/array/object/node 预算有界投影并产生截断诊断；该降级不用于已知正文。

## 仍需 yyt 提供的最小脱敏采样

在用户自行安装并登录 Qoder/Qoder CLI 后，只需提供以下脱敏证据；不要提供账号、
token、cookie、完整真实会话或工作区源码：

1. 2–3 个新建空白测试项目中的目录树和文件名形状：普通多轮、工具调用、
   Quest/subagent 或 fork/compact 各一个。
2. 每类 JSONL 记录只保留 key、值类型、枚举和合成占位内容；sidecar 同样只保留
   schema 形状。
3. 明确 usage 字段是否真实出现、是累计还是逐消息、cache 是否包含于 input；若无法
   证明，继续保持 experimental/unavailable。
4. `qodercli --version`、`qodercli --help` 中 Resume 参数的最小脱敏片段，以及用纯
   合成会话执行 `-r` 后的 source ID 与内容 anchor 对照。
5. compact 前后是否保留原始历史、是否出现边界/摘要、模型实际上下文是否可由源文件
   证明。没有证据就继续标 unavailable。
