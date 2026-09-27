# Changelog

[中文](CHANGELOG.zh.md)

## Unreleased

### New

- **`swob doctor checkup` — a read-only kernel checkup report** — compares what the Swob kernel reads with an independent count of the raw session data and writes an owner-readable Markdown report plus its JSON (`--report <dir>` writes `Swob内核体检-<date>-<machine tag>.md/.json` and `最新-<machine tag>.md`; stdout gets a one-line digest). The kernel runs in an isolated child process against a throw-away HOME; a before/after metadata audit of Swob's state, the library's `.swob` and the source databases must come back unchanged, reports must pass a privacy whitelist scan, and a same-machine previous report is compared automatically. New exit codes for this command: 4 (`--fail-on` met), 5 (read-only or isolation guarantee did not hold), 6 (the Swob app is running), 7 (privacy scan refused). Not available on Windows yet.

### Fixed

- **`swob insights` token label now names what it counts (breaking for JSON consumers; numbers unchanged)** — the insights token totals were labelled `input_plus_output`, but they have always been the billing total: non-cached input + cache read + cache write + output. The label is now `billing_total`: `totalTokensMetric` (in both the `--summary` and the full `--json` output) and `tokenMetric` on the summary's `bySource`, `byModel` and `topProjects` rows. Every number is exactly as before; only the label string changed, so consumers that match `input_plus_output` on insights output must switch to `billing_total`. `swob list` and `swob search` keep `tokenMetric: "input_plus_output"` (non-cached input + output, no cache), which was already correct. An installed /swob Skill picks up the new wording after `swob install`.
- **Forked Codex subagents no longer take over their parent's valuation** — a forked subagent copies its parent's token usage, and `swob insights` and the session audit valued that copy (often without a model, so unpriced, or at the subagent's model) instead of the parent's own call. Valuation now picks the call for each billing fact the same way the token totals do, so the main-thread call wins over a copy, as it already did on the Insights page. Token totals are unchanged.
- **`swob doctor checkup` no longer reports its own inferences as kernel failures** — ② now compares Codex with the kernel's own per-file read count (records holding U+2028/U+2029 were inferred as lost, although the kernel has kept them since the reader fix), and a file without a read count is left out and listed instead of inferred; ③ explains a Codex session with several copies whose count equals one copy (a warning, no longer a failure) and counts each file by the kernel's rule; with `--sources` the report head, the digest and the inventory say that only some sources were checked, `--report … --json` adds `sourcesSelected`, and a file target named like a canonical report (`Swob内核体检-<date>-<machine tag>.md`, `最新-<machine tag>.md`) is refused. The checkup version is now 1.2.0.
- **`swob doctor checkup` says no more than it measured** — a `--sources` digest now counts 「所选来源 N 场会话」 (the selected sources) instead of 「全部」; when a source got no read count at all, the ② one-liner and the digest name that source (「本轮未取得读数」) instead of saying every record was read; and the owner-facing explanations were rewritten, e.g. records with special line separators now read 「Swob 这次读到的比原始记录少」. Verdicts and numbers are unchanged.
- **`swob insights --json` valuation reconciliation no longer fails on rounding** — `reconciliation.valuation.ok` compared the per-session and per-call USD sums of the same calls against an absolute 1e-12, which is smaller than the last bit of any total above $8,192, so on a real library it stayed `false` over a rounding difference (5e-11). The USD check now allows 1e-9 of the total; coverage must still match. No amounts change.
- **Per-model and per-day usage no longer count a forked Codex subagent's copies** — the session audit's per-model rows (and the insights report's top models), `swob insights`' `byModel` and its per-day figures (`byDate`, heatmap, hourly distribution, active days, unknown-time usage) added up every usage row, including the rows a forked subagent copies from its parent, so per-model rows could add up to more than the session's value, and `byModel` or `byDate` to more than `totalTokens`. Each billing fact now counts once, as the call the totals count; for Codex a model row's `turns` becomes the number of those calls. Totals are unchanged.
- **The usage ledger no longer rolls back a whole sync because one session degraded** — when an OpenCode or ZCode session fell back from per-call usage to its legacy session total, the ledger hit a primary-key conflict on the total it had once replaced and rolled back every source's update, so the Insights page silently stayed on an old snapshot (on one real library, since 2026-08-20). Now a session whose input falls back to that total, or has no usage this time (a failed read, a placeholder), keeps the usage it last committed while the rest of the sync goes in; a session left with nothing but the replaced total counts that total again. The fallback also keeps the reason codes for why the per-call rows were refused.
- **Insights shows when its ledger was last updated, and a failing sync** — a line under the filters reads "Ledger updated <time>" and, while the background usage sync keeps failing, "Last sync failed: <code> (N in a row)". The failure is also written to lifecycle.log once when it starts, when its code changes and when it recovers.

## v1.4.0 — 2026-08-08

### New

- **Thirteen native sources, one compatible** — Antigravity, Grok, Kimi, Hermes, Qoder, Trae, and Gemini join Claude Code, Codex, Cursor, OpenCode, ZCode, and Pi as natively parsed sources; CC-Mirror remains supported as a compatible format. Capability tiers stay evidence-based: encrypted or restricted formats degrade honestly instead of guessing.
- **Windows x64 Beta (unsigned)** — a first Windows build with onboarding, discovery, reading, search, Insights, and settings. Beta means CI-verified only; see Known limitations.
- **Startup performance overhaul** — warm starts now compute a real dirty set instead of re-syncing every session, cold syncs run in bounded batches with a resumable checkpoint, and Search/Usage projections queue behind a single idle-scheduled gate. On a real ~1,450-session library, the first post-upgrade launch completes its one-time full catch-up in about 10 minutes and later launches settle in about a minute; the old build was still at 22% after 20 minutes.
- **Library health you can see** — a health state machine with freshness tracking, a visible health panel with a guided recovery action, and recovery compensation queues.
- **Declarative lens packs** — extend Swob with `.swoblens` files instead of code.
- **Auditable cost ledger** — cost and valuation dimensions with price snapshots, pagination for large ledgers, and value history queries; a Lens platform and theme selector round out the workspace.

### Fixed

- A crashed writer could leave the whole library silently read-only; the writer lease now recovers explicitly and health status reports it instead of hiding it.
- Session indexes no longer drift hours behind live activity; resume sessions launched with `=`-style arguments are recognized.
- Galaxy layout regressions and render flicker are fixed with source-partition clustering and canvas size guards.
- Library preferences survive startup hydration races.
- Shutdown no longer triggers native aborts or spurious warnings from the library worker.

### Known limitations

- `swob active` cannot detect Claude Code sessions embedded inside Claude Desktop (they spawn no native `claude` process), nor sessions started without `--resume` (no session id to associate). The capability matrix reflects this boundary.
- The Windows build is Beta and unsigned: it is CI-verified only and has not passed hands-on Windows 11 validation. SmartScreen warnings are expected.
- The first launch after upgrading performs a one-time full catch-up (about 10 minutes on large libraries) while the new checkpoint is established; subsequent launches are incremental.

## v1.3.1 — 2026-07-24

### New

- **Logical conversation history** — duplicate packages and compact/resume continuations are now connected as one explainable history without hiding the underlying physical sessions.
- **Personal presentation** — choose a user avatar and override built-in provider icons with locally managed PNG, JPEG, WebP, or sanitized SVG assets.
- **Signed update channel** — v1.3.0 and later can receive a gated, signed in-app update after the candidate has passed a real install-and-relaunch check.

### Fixed

- Session counts, source health, and Insights now stay aligned with authoritative local evidence; stale or partial data no longer crashes the Insights page.
- Sessions with incomplete detail data now show the available transcript or a recoverable/unavailable explanation instead of an empty pane.
- “All sessions” groups collapse reliably, large groups remain responsive, search reports real empty results, and compact windows preserve a readable conversation column.
- The detail inspector now exposes Outcomes, Activity, and Details consistently; file trees and continuation relationships no longer silently omit known evidence.
- CLI installation now performs the required privileged symlink step through the macOS authorization flow instead of asking users to paste a `sudo ln` command.
- User and provider presentation changes persist in the Library, reload live, and reject unregistered providers or unsafe SVG content.
- The official website now downloads the detected Mac build directly and always exposes an explicit alternate-architecture link.

## v1.3.0 — 2026-07-23

> **Manual upgrade required:** v1.2.0 and earlier cannot cross the previous ad-hoc/unsigned trust boundary through auto-update. Download the matching v1.3.0 DMG and replace the installed app once; v1.3.0 intentionally publishes no update metadata.

### New

- **Session Galaxy and lineage navigation** — explore large session collections as a stable, filterable graph, follow related-session and execution trees, and inspect context pressure without leaving the conversation view.
- **Provider capability tiers** — parse six native formats plus one Claude-compatible format; detect four additional experimental sources without claiming transcript, search, or audit support where message bodies are unavailable.
- **Session Audit and AI Insights** — added evidence-backed quality diagnostics, bounded analysis scopes, request-level token attribution and valuation, plus explicit privacy confirmation before any optional LLM request.
- **Agent workflows** — added the packaged CLI contract, multi-profile LLM configuration, smart rename, the in-app agent panel, share-image export, and command/view/widget registries.
- **Library and onboarding tools** — added source-aware onboarding, capacity estimates, Vault migration, lenses, undoable organization, duplicate recovery planning, and clearer source-health surfaces.

### Fixed

- Made Library writes fail closed with a single-writer lease, generation checks, and recovery-safe state transitions.
- Restored reliable source watchers, Keychain access, packaged CLI native dependencies, SSH/cloud resume routing, session navigation, and update-safe provider identities.
- Closed path-containment, private-fixture, credential-redaction, provider-protocol, package-boundary, and release-signing gaps found during security and compliance review.
- Made SSH public-IP discovery opt-in: opening or refreshing SSH settings stays local, and only an explicit button click sends a five-second request to `api.ipify.org`.
- Unified user-visible copy, locale enforcement, navigation entry points, Insights coverage semantics, and Galaxy layout stability.

### Architecture

- Moved search to SQLite FTS5, bounded renderer work with virtualization, coalesced watchers, and isolated graph/layout work in workers.
- Froze a canonical provider protocol and capability truth layer, then moved presentation and extension points behind typed registries.
- Added fail-closed release gates for Developer ID signing, notarization, stapling, package contents, update metadata, and signed-update trust roots.
- Relicensed Swob under Apache-2.0 starting with v1.3.0. Releases v1.2.0 and earlier remain AGPL-3.0-only.

## v1.2.0 — 2026-07-18

### New

- **Session lineage (backend)** — precise relationship detection between sessions: fork edges, continuation edges (via compact summary links), multi-file resumes. Relationships persist in an on-disk lineage registry and survive cache rebuilds. Visual tree view coming next.
- **Two new sources: OpenCode & Zcode** — reads `~/.local/share/opencode/opencode.db` and `~/.zcode/cli/db/db.sqlite`. Browse, search, transcript, and insights for all five tools in one place.
- **In-app updates** — Swob now checks GitHub Releases on launch (non-blocking) and shows an update banner. Download and install without leaving the app. Manual check available in Settings.
- **Secret redaction layer** — generated transcripts pass through a credential detector (API keys, tokens, PEM blocks, JWT, high-entropy strings) with masked output like `WK……1p1U`. New CLI command: `swob redact [--dry-run]` to backfill-redact existing transcripts. Session IDs, git SHAs, and URLs are whitelisted — structural data is never mangled.
- **Real-time transcripts** — active sessions' Markdown transcripts update within seconds of new messages (fs watchers on the active set, 48h window).

### Faster

- **Startup 23.9× faster** — per-file incremental cache; hot start 641ms → 27ms. First-ever start no longer takes minutes on large session collections.
- **Global search 19.9× faster** — per-file text cache; typical query 58ms → 3ms.

### Fixed

- Codex transcript denoising (instructions/environment blocks no longer pollute first message or titles).
- Cursor resume no longer silently no-ops; unknown sources show a disabled state instead of a missing button.

## v1.1.0 — 2026-03-23

- Spotlight session jump (`⌘⇧K`), token insights dashboard, iCloud backup, CLI (`swob`), Cursor support.

## v1.0.0 — 2026-03-12

- First release: browse/search/resume Claude Code & Codex sessions, compact-block expansion, folders & highlights.
