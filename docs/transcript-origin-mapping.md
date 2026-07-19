# Transcript 来源判定映射

本文只定义 Claude Code `type: "user"` 记录的来源。`assistant` / `system` 的角色已由 `type` 明确，不用本字段重新命名。其它 harness 暂无经过样本验证的等价字段，统一返回 `unknown`。

## 样本核验

2026-07-19 对 `~/.claude/projects/**/*.jsonl` 做只读结构扫描；扫描只输出字段名、content part 类型、Claude Code 版本和 UUID 后四位，不输出路径或正文。仓库样本同时核对 `src/main/derived-files.test.ts`、`src/main/session-loader.test.ts` 与 `src/shared/chat-format/text.test.ts`。

| 来源 | 判定字段（从强到弱） | 脱敏后的真实结构证据 | 结论 |
| --- | --- | --- | --- |
| `human` | `origin.kind === "human"`；旧记录退化为普通字符串/普通 `text`、`image`、`document` 数组，且无机器证据 | Claude Code 2.1.201：`promptSource:"typed"`、字符串、`origin.kind:"human"`（`…206a`）；2.1.209：`promptSource:"sdk"`、字符串、`origin.kind:"human"`（`…dc40`）。扫描时至少见 `origin.kind:"human"` 903 条 | 顶层 `origin.kind` 是最强真人证据；`sdk` 本身不是真人证据 |
| `task-notification` | `origin.kind === "task-notification"`；旧记录仅在首个有效文本以 `<task-notification>` 起始时回退匹配 | Claude Code 2.1.201：字符串、`promptSource:"sdk"`、`origin.kind:"task-notification"`（`…9a37`）；同版本 `promptSource:"system"`（`…8cc6`）。本机共见该结构 427 条 | 新结构不依赖正文；旧结构只认起始标签 |
| `hook` | 已知结构化 `origin.kind === "hook"`；否则首个有效文本以 `<system-reminder>` / `<user-prompt-submit-hook>` / `UserPromptSubmit hook success` 起始 | 当前本机主消息中没有独立 hook 正例；命中这些字样的记录均位于 `tool_result.content` 或工具参数正文，不能当 hook。仓库 `src/shared/chat-format/text.test.ts` 保留 `<user-prompt-submit-hook>…</user-prompt-submit-hook>` 的既有 Claude 格式 fixture；任务书另给出 `<system-reminder>` 与 `UserPromptSubmit hook success` 结构 | 不把正文中途出现的 hook 字样当来源证据。`isMeta:true` 只证明元消息，不能单独判 hook |
| `command` | 已知结构化 `origin.kind === "command"`；否则首个有效文本以命令包装标签起始 | Claude Code 2.1.201：`<command-name>` 字符串（`…5f23`）、`<local-command-stdout>` 字符串（`…9636`）、`isMeta:true` + `<local-command-caveat>`（`…5d74`） | 标签包括 `command-name`、`command-message`、`command-args`、`local-command-stdout`、`local-command-caveat`；本机还实见 `bash-input` / `bash-stdout`，一并归 command |
| `tool` | content 数组含 `type:"tool_result"`；或已知结构化 `origin.kind === "tool"` | Claude Code 2.1.201：`content:[{type:"tool_result",…}]`，并有顶层 `sourceToolAssistantUUID` / `toolUseResult`（`…15e5`、`…67e2`） | `tool_result + text` 混合数组仍是 tool，不能因有 text 改判 human |
| `unknown` | 结构字段明确非真人但不能细分；未知 `origin.kind`；`isMeta:true` 无已知子类；已知机器固定语句；未知的起始 XML 标签；缺失/非普通 content | Claude Code 2.1.201：compact continuation 字符串（`…e8c8`、`…0bc6`）；2.1.209：`isMeta:true` + `Base directory for this skill:` text part（`…776d`、`…8b96`） | 不把 unknown 回退成 human；`isMeta` 的真实样本证明它不是 hook 专属字段 |

> hook 栏的本机正例缺口必须保留：现有本机语料不能证明一条独立 hook 消息的完整顶层结构。实现只采纳任务书给定且仓库已有 fixture 支持的起始包装，不根据正文中途字样猜测。

## 判定树

1. 非 Claude Code 来源，返回 `unknown`。
2. 不是 `type:"user"` 或缺少 `message`，返回 `unknown`。
3. 读取顶层 `origin.kind`（并兼容同值的字符串 `origin`）：
   - 值为六个受支持枚举之一时直接采用；
   - 字段存在但值未知时返回 `unknown`，不再用标签覆盖结构字段。
4. content 数组含 `tool_result` 时返回 `tool`。
5. `promptSource` 明确为 `typed`、`queued` 或 `suggestion_accepted` 时，先记为结构化真人证据；明确为 `system` 时，先记为结构化机器证据；`sdk` 不单独证明任何来源。
6. 只检查首个有效文本的起始处：
   - task 标签 → `task-notification`；
   - command 标签 → `command`；
   - hook 标签/固定前缀 → `hook`。
   结构化真人证据与标签冲突时，按结构化证据返回 `human`。
7. `isMeta:true`、`promptSource:"system"`、compact continuation、skill 元消息、旧固定机器语句或未知起始 XML 标签 → `unknown`。
8. 剩余的普通字符串或只含 `text` / `image` / `document` 的普通数组 → `human`；其它形态 → `unknown`。

## 防误判边界

- `请解释正文里的 <task-notification> 字样`：标签不在整段起始，判 `human`。
- `origin.kind:"human"` 且正文以机器标签开头：结构字段优先，判 `human`。
- `origin.kind:"future-kind"`：结构存在但实现不认识，判 `unknown`。
- `isMeta:true` + 普通文本：只能确认不是普通真人输入，判 `unknown`。
- 任意其它 harness：即使外形像 Claude 标签，本单也判 `unknown`。
