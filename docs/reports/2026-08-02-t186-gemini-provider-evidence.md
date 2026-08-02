# T186 Gemini CLI Provider evidence

## Observed formats

- Local probe: `gemini 0.38.2`; `gemini --help` exposes `-r, --resume` and
  `--list-sessions`. Its installed Apache-2.0 bundle writes legacy, whole-file
  `session-*.json` conversations.
- First-party Gemini CLI commit
  `f47d6c6f7a1308d81f9f57acf7d279f0928c5249` writes append-only JSONL, migrates
  legacy JSON on resume, replaces repeated message IDs, supports `$rewindTo`,
  and stores metadata updates as `$set` records.
- AgentsView MIT commit `1cd581fe34e87e134160c6668deffb674b7eaa4e`
  was used as an independent comparison. Swob does not copy its cross-turn
  prompt-delta assumption: first-party Gemini documents each stored `tokens`
  object as one response's `GenerateContentResponseUsageMetadata`.

## Eight-layer truth table

| Layer | Grade | Boundary |
| --- | --- | --- |
| Discovery | exact | `~/.gemini/tmp/<project>/chats`, top-level JSON/JSONL and nested subagent JSON/JSONL. |
| Metadata | exact | Persisted session ID, project hash, timestamps, summary, directories and kind. |
| Messages | exact | Visible content and thought summaries/parts remain separate canonical blocks. |
| Tools | exact | Persisted function calls, args, status and inline results. |
| System + compact | derived | System records and JSONL rewind/checkpoint operations are preserved; model-context membership is unavailable. |
| Token | exact | Prompt, candidate, cache, thoughts, tool and provider total are retained; repeated same-ID stream snapshots are last-write-wins. |
| Relationships | derived | Nested subagent path + `kind=subagent`; no explicit parent field exists. |
| Resume | derived | Binary/version/help/source preflight exists; authenticated post-launch anchor evidence is still pending. |

Gemini API defines cached tokens as a subset of prompt tokens, while its own
recorded responses prove `total=prompt+tool-use prompt+candidates+thoughts`.
Swob therefore maps `input.total=prompt+tool`, `input.cacheRead=cache`, and
derives `input.uncached=prompt-cache+tool` only when the counters satisfy that
invariant. The original prompt/candidate/cache/thought/tool/total object is also
retained verbatim as a bounded `gemini.usage.rawBuckets` event. Candidates and
thoughts are disjoint output buckets, so
`output.total=candidates+thoughts`, with the original buckets retained as
`visible` and `reasoning`. No character estimate is used.

Grounding, citation and URL-context metadata are not part of the current
first-party chat-recording type. If a producer version persists them, Swob
retains the complete bounded object as a typed `unknown` canonical event rather
than dropping or inventing citation semantics.

## Resume boundary

The task requested an authenticated launch and anchor observation. No private
session was opened or copied. A Vault mailbox request asks for a deliberately
generated, locally redacted sample and post-resume UUID/content-anchor result.
Until that evidence arrives, terminal resume is `experimental`, never
`available`.

## Qwen reconnaissance only

Qwen Code remains a separate future provider ID (`swob/qwen-code`), not a Gemini
format alias. At official Qwen commit
`4c6e2518a38283931c8d7606a3ea9bba71ee8876`, its docs expose `/resume`, CLI
`--resume`, `qwen sessions list --json`, `~/.qwen`/`QWEN_HOME`, and explicit
JSON/JSONL export. Those product contracts require an independent discovery,
format, usage and resume audit; t186 intentionally adds no Qwen runtime or
capability row.
