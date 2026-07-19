# Transcript 来源判定映射

本文只定义 Claude Code `type: "user"` 记录的来源。`assistant` / `system` 的角色已由 `type` 明确，不用本字段重新命名。其它 harness 暂无经过样本验证的等价字段，统一返回 `unknown`。

## 样本核验

2026-07-19 对 `~/.claude/projects/**/*.jsonl` 做只读结构扫描；扫描只输出字段名、content part 类型、Claude Code 版本和 UUID 后四位，不输出路径或正文。仓库样本同时核对 `src/main/derived-files.test.ts`、`src/main/session-loader.test.ts` 与 `src/shared/chat-format/text.test.ts`。

| 来源 | 判定字段（从强到弱） | 脱敏后的真实结构证据 | 结论 |
| --- | --- | --- | --- |
| `human` | `origin.kind === "human"`；或普通字符串/普通 `text`、`image`、`document` 数组同时具有白名单 `promptSource`：`typed` / `queued` / `suggestion_accepted` | Claude Code 2.1.201：`promptSource:"typed"`、字符串、`origin.kind:"human"`（`…206a`）；本机另见 `queued + human` 37 条、`suggestion_accepted + human` 2 条。2.1.209 的 `sdk + human`（`…dc40`）只由 `origin.kind` 证明真人 | 顶层 `origin.kind` 是最强真人证据；`sdk`、未知值或字段缺失均不单独证明真人 |
| `task-notification` | `origin.kind === "task-notification"`；旧记录仅在首个非空白有效文本以 `<task-notification>` 起始时回退匹配 | Claude Code 2.1.201：字符串、`promptSource:"sdk"`、`origin.kind:"task-notification"`（`…9a37`）；同版本 `promptSource:"system"`（`…8cc6`）。本机共见该结构 427 条 | 新结构不依赖正文；旧结构跳过空白 text 后只认首个有效文本的起始标签 |
| `hook` | 已知结构化 `origin.kind === "hook"`；否则首个有效文本以 `<system-reminder>` / `<user-prompt-submit-hook>` / `UserPromptSubmit hook success` 起始 | 当前本机主消息中没有独立 hook 正例；命中这些字样的记录均位于 `tool_result.content` 或工具参数正文，不能当 hook。仓库 `src/shared/chat-format/text.test.ts` 保留 `<user-prompt-submit-hook>…</user-prompt-submit-hook>` 的既有 Claude 格式 fixture；任务书另给出 `<system-reminder>` 与 `UserPromptSubmit hook success` 结构 | 不把正文中途出现的 hook 字样当来源证据。`isMeta:true` 只证明元消息，不能单独判 hook |
| `command` | 已知结构化 `origin.kind === "command"`；否则首个有效文本以命令包装标签起始 | Claude Code 2.1.201：`<command-name>` 字符串（`…5f23`）、`<local-command-stdout>` 字符串（`…9636`）、`isMeta:true` + `<local-command-caveat>`（`…5d74`） | 标签包括 `command-name`、`command-message`、`command-args`、`local-command-stdout`、`local-command-caveat`；本机还实见 `bash-input` / `bash-stdout`，一并归 command |
| `tool` | `origin.kind === "tool"`；content 数组含 `type:"tool_result"`；或顶层存在 `sourceToolAssistantUUID` / `toolUseResult` | Claude Code 2.1.201：`content:[{type:"tool_result",…}]`，并有顶层 `sourceToolAssistantUUID` / `toolUseResult`（`…15e5`、`…67e2`） | 顶层工具字段和 `tool_result` 都先于 promptSource；规整成普通 text 后仍不能判 human |
| `unknown` | 结构字段明确非真人但不能细分；未知 `origin.kind`；`isMeta:true` 无已知子类；`sdk` / 未知 / 缺失 `promptSource` 且无其它真人证据；纯 `[Image: source: …]` 占位；已知机器固定语句；未知的起始 XML 标签；缺失/非普通 content | Claude Code 2.1.201：compact continuation 字符串（`…e8c8`、`…0bc6`）；2.1.209：`isMeta:true` + `Base directory for this skill:` text part（`…776d`、`…8b96`） | 图片占位只能证明不是发言，不能证明具体工具来源，故诚实归 `unknown`；任何不确定值都不回退 human |

> hook 栏的本机正例缺口必须保留：现有本机语料不能证明一条独立 hook 消息的完整顶层结构。实现只采纳任务书给定且仓库已有 fixture 支持的起始包装，不根据正文中途字样猜测。
>
> **缺口定性（2026-07-20 实证，二次验收后补）**：对一个每轮都有 UserPromptSubmit hook 注入的活跃会话 jsonl 全量核查——该会话全部 22 条非 tool_result 用户记录中，hook 文本（额度行/机器通知/system-reminder）零出现；真人记录的 content 干净、且带 `origin`/`promptSource` 结构字段。结论：**Claude Code（≤2.1.2xx）不把 hook 注入内容写入会话 jsonl**，hook 内容仅存在于运行时请求。因此「hook 独立正例」在本数据源中按构造不存在，`hook` 类为防御性分类（护栏应对未来格式变化），其样本要求按此修订为「实证记录 + 防御性合成用例」。若未来版本开始落盘 hook 记录，需先补真实样本再扩展判定字段。

## 判定树

1. 非 Claude Code 来源，返回 `unknown`。
2. 不是 `type:"user"` 或缺少 `message`，返回 `unknown`。
3. 读取顶层 `origin.kind`（并兼容同值的字符串 `origin`）：
   - 值为六个受支持枚举之一时直接采用；
   - 字段存在但值未知时返回 `unknown`，不再用标签覆盖结构字段。
4. content 数组含 `tool_result`，或顶层存在 `sourceToolAssistantUUID` / `toolUseResult` 时返回 `tool`。这些工具证据先于 `promptSource`。
5. 跳过空白字符串/空白 `text`，只检查首个非空白有效文本的起始处：
   - task 标签 → `task-notification`；
   - command 标签 → `command`；
   - hook 标签/固定前缀 → `hook`。
6. `isMeta:true`、`promptSource:"system"`、纯图片来源占位、compact continuation、skill 元消息、旧固定机器语句或未知起始 XML 标签 → `unknown`。
7. 仅当 `promptSource` 为白名单 `typed` / `queued` / `suggestion_accepted`，且 content 是普通非空字符串或只含普通 `text` / `image` / `document` 的数组时返回 `human`。
8. `sdk`、未知/未来值、缺失 `promptSource` 以及其它剩余形态一律返回 `unknown`，绝不兜底为 `human`。

## 防误判边界

- `promptSource:"typed"` + `请解释正文里的 <task-notification> 字样`：标签不在整段起始，且有白名单真人证据，判 `human`。
- `origin.kind:"human"` 且正文以机器标签开头：结构字段优先，判 `human`。
- `origin.kind:"future-kind"`：结构存在但实现不认识，判 `unknown`。
- `isMeta:true` + 普通文本：只能确认不是普通真人输入，判 `unknown`。
- `promptSource:"sdk"`、未来值或字段缺失 + 普通文本：没有白名单真人证据，判 `unknown`。
- 纯 `[Image: source: /redacted/a.png]`：只有占位形态证据，无法证明 tool 子类，判 `unknown`。
- 任意其它 harness：即使外形像 Claude 标签，本单也判 `unknown`。
