# T175B Trae Provider capability evidence

Observed product: Trae 1.100.3 on macOS. The current product profile contains an encrypted
`ModularData/ai-agent/database.db`; its legacy `state.vscdb` row is only an empty stub.
Swob therefore parses the evidenced legacy layout and explicitly does not claim that the
current encrypted layout is readable.

| Layer | Measurement | Product capability | Evidence / boundary |
| --- | --- | --- | --- |
| Discovery | exact | experimental | Exact legacy `workspaceStorage` / `globalStorage` DB discovery; modern encrypted layout is detected but not parsed. |
| Metadata | exact | experimental | `sessionId`, title, timestamps and `workspace.json` project URI when present. |
| Messages | exact | experimental | Ordered user/assistant/system text and allowlisted tab/bubble shapes from the legacy JSON list. |
| Tools | unavailable | unavailable | No verified legacy fixture or current plaintext producer field exposes tool calls/results. |
| System + compact | unavailable | unavailable | No authoritative compact boundary or model-context membership; events use `unknown` context membership. |
| Token | unavailable | unavailable | No authoritative usage counters; Swob emits no zero or character estimate. |
| Relationships | unavailable | unavailable | No verified parent/fork/subagent fields in the observed Trae legacy shape. |
| Resume | unavailable | unavailable | IDE workspace opening is not verified per-session Resume and no source-anchor postcondition exists. |

Synthetic fixture: `testdata/trae/legacy-state-vscdb.json`.
Conformance IDs use the `PPV2-TRAE-*` prefix. Upstream reference is pinned in
`testdata/trae/NOTICE`; the real local profile is never copied into testdata or Library.
