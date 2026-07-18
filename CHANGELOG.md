# Changelog

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
