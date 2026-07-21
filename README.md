<div align="center">

<img src="site/assets/favicon.svg" alt="Swob" width="72" height="72" />

# Swob

### A git graph for your AI conversations

**Recover lost context. Trace forks and compactions. Debug how your agents actually worked.**

Swob reads local histories from **11 AI coding harnesses**, reconstructs session lineage, indexes every message with SQLite FTS5, and adds an execution tree, context inspector, provenance-aware audit, and optional AI Insights.

[Website](https://ivyyang1999.github.io/swob/) · [Apple Silicon DMG](https://github.com/IvyYang1999/swob/releases/download/v1.2.0/swob-1.2.0-arm64.dmg) · [Intel DMG](https://github.com/IvyYang1999/swob/releases/download/v1.2.0/swob-1.2.0-x64.dmg) · [Changelog](CHANGELOG.md)

[English](README.md) · [中文](README.zh.md) · [日本語](README.ja.md)

![Latest release](https://img.shields.io/github/v/release/IvyYang1999/swob?label=stable)
![Platform](https://img.shields.io/badge/platform-macOS-2d2d30)
![Build](https://img.shields.io/github/actions/workflow/status/IvyYang1999/swob/release.yml?label=release)
![Downloads](https://img.shields.io/github/downloads/IvyYang1999/swob/total)
![License](https://img.shields.io/badge/license-AGPL--3.0-5b4fc4)

</div>

> [!IMPORTANT]
> **Product channels are intentionally separated.** The screenshots and debugger features below are real captures from current `main` using sanitized demo data. The public **v1.2.0 stable DMGs predate Session Galaxy, 11-harness ingestion, Session Debugger, AI Insights, and SQLite FTS5**. Build `main` from source to try them now; they will ship in the next release.

![Swob Session Galaxy — current main with sanitized demo data](site/assets/graph-view.png)

<p align="center"><sub>Current <code>main</code> · real Swob UI · sanitized demo data · no generated product mockups</sub></p>

## Why Swob exists

AI coding sessions are not isolated chat files. A resume creates another file. A fork splits a task. A compaction replaces earlier context with a summary. Different agents store the same kind of work in incompatible locations. A normal viewer can show one transcript; it cannot explain where that transcript came from or why the agent lost the plot.

Swob treats session history as evidence:

- **Trace lineage** — navigate verified fork and continuation relationships in an interactive, force-directed Session Galaxy.
- **Recover context** — expand compacted Claude Code turns and preserve local backups after the source has disappeared.
- **Debug execution** — inspect tool/agent calls, token pressure, compaction boundaries, latency, framework overhead, errors, and anti-patterns.
- **Search everything** — SQLite FTS5 indexes local messages incrementally instead of rescanning the archive for every query.
- **Resume safely** — return to a supported CLI with its session ID and working directory, with source-aware validation.

## Evidence, not vanity metrics

| Audited result | What it means |
|---|---|
| **253 / 1,621** | 253 Claude Code source sessions in one audited library were already missing under the default 30-day retention policy; Swob still had local backups. |
| **93.58%** | Verified resumability in the same 1,621-session, five-source audit corpus. This is an observed corpus result, not a universal success guarantee. |
| **1,704 sessions** | Current local performance and UI corpus used to exercise the new index and dashboard. |
| **11 harnesses** | Current `main` discovers histories from 11 source families; parsing depth and resume support vary with source data and CLI capabilities. |

## Session Galaxy

The current graph is a real Canvas-based, force-directed view. It distinguishes verified lineage edges from softer project/source/time grouping and lets you pan, zoom, inspect, and open a session. A prior PixiJS prototype was deliberately reverted for further work; Swob does **not** claim WebGL rendering today.

## Session Debugger

Swob goes beyond transcript rendering:

- **Execution Tree** — reconstructs turns, tool calls, sub-agent spawns, errors, durations, and cumulative token use.
- **Context Inspector** — breaks context into user, assistant, tool input/output, system injection, thinking, image, and compact slices; marks compact boundaries and pressure warnings.
- **Session Audit** — a 12-dimension workflow audit covering research/edit balance, thinking evidence, latency, estimated cost, framework overhead, session type, model use, tool efficiency, interruptions, goal length, anti-patterns, and frustration signals.
- **Provenance labels** — metrics are labeled `reported`, `estimated`, or `unavailable`; missing evidence is not presented as fact.

| Session Audit | Execution Tree + Context Inspector |
|---|---|
| ![Session Audit in current Swob main](site/assets/session-audit.png) | ![Execution Tree and Context Inspector in current Swob main](site/assets/session-debugger.png) |

## Insights across all sessions

The local dashboard includes token and cost totals, a 365-day heatmap, source/model/project breakdowns, hourly and turn distributions, tool usage, code-change counts, and an audit report.

**AI Insights is optional and off until configured.** When explicitly invoked, it sends aggregate metrics plus a bounded sample of real user messages to the provider you configure. Read [PRIVACY.md](PRIVACY.md) before enabling it.

![Swob Insights dashboard in current main](site/assets/insights-dashboard.png)

## Sources in current `main`

| Source family | Local history discovery | Notes |
|---|---:|---|
| Claude Code | Stable | Deepest lineage, compact recovery, backup, audit, and resume support. |
| Codex | Stable | Local rollout parsing, search, insights, and resume. |
| Cursor | Stable | Local agent history, search, insights, and resume where the CLI exposes it. |
| OpenCode | Stable | SQLite history ingestion and normalized viewing. |
| Zcode | Stable | SQLite history ingestion and normalized viewing. |
| CC Mirror | Current main | Claude-compatible project histories. |
| Antigravity | Current main | Current and legacy local transcript roots. |
| Grok / Factory | Current main | JSONL histories from Grok and Factory/Droid roots. |
| Pi | Current main | Local agent session histories. |
| Kimi Code | Current main | Local `wire.jsonl` histories. |
| Hermes | Current main | Local JSON session histories. |

“Discovered” does not mean every source exposes identical metadata. Swob preserves source limitations instead of manufacturing missing tokens, lineage, or resume commands.

## How Swob compares

Public README claims checked on 2026-07-21. `✅` = explicitly documented; `◐` = adjacent or partial capability; `—` = not documented as a current feature. This is a capability map, not a quality score.

| Capability | Swob current `main` | [Claude Code History Viewer](https://github.com/jhlee0409/claude-code-history-viewer) | [Agent Sessions](https://github.com/jazzyalex/agent-sessions) | [SessionView](https://github.com/tyql688/sessionview) |
|---|---|---|---|---|
| Local multi-harness history | ✅ 11 source families | ✅ 9 providers | ✅ 9+ agents | ✅ 9 tools |
| Visual session lineage graph | ✅ verified + grouping edges | ◐ Session Board, not lineage | — | ◐ child-session normalization, no lineage graph documented |
| Compact-history recovery | ✅ Claude Code | — | — | — |
| Execution tree / agent-call anatomy | ✅ | ◐ tool rendering | ◐ tool/output navigation | ◐ tool-call mix and child sessions |
| Context pressure inspector | ✅ per-turn categories + compact boundaries | ◐ token analytics | ◐ quota/session runway | ✅ session context/cache analytics |
| Provenance-aware health audit | ✅ | — | ◐ honest quota states | — |
| Local full-text search | ✅ SQLite FTS5 | ✅ | ✅ local index | ✅ SQLite FTS5 |
| Resume in source CLI | ✅ where supported | ◐ open/focus by session | ✅ supported CLIs | ✅ where supported |
| Headless / browser mode | — | ✅ | — | ✅ |

## Install

### Stable v1.2.0

| Mac | Direct download |
|---|---|
| Apple Silicon (`arm64`) | [Download `swob-1.2.0-arm64.dmg`](https://github.com/IvyYang1999/swob/releases/download/v1.2.0/swob-1.2.0-arm64.dmg) |
| Intel (`x64`) | [Download `swob-1.2.0-x64.dmg`](https://github.com/IvyYang1999/swob/releases/download/v1.2.0/swob-1.2.0-x64.dmg) |

**System requirement:** macOS on Apple Silicon or Intel.

> [!WARNING]
> The public v1.2.0 DMGs are **not signed or notarized**. The signing pipeline has passed an isolated smoke test, but no signed public release exists yet. If Gatekeeper reports that Swob is damaged or cannot be opened, verify the download came from this repository, then run:
>
> ```bash
> xattr -cr /Applications/Swob.app
> ```

### Current `main`

```bash
git clone https://github.com/IvyYang1999/swob.git
cd swob
npm ci
npm run dev
```

To build local DMGs:

```bash
npm run build:mac
```

## CLI

```bash
swob search "auth regression"    # local cross-session search
swob list --source codex         # filter by source
swob resume <session-id>         # print the source-aware resume command
swob insights                    # aggregate local usage
swob active                      # inspect running sessions
swob install                     # install CLI + Agent Skill
```

CLI commands return JSON so other agents can query Swob without scraping the UI.

## Privacy and security

- Core browsing, indexing, lineage, audit, and Quick Report computation run locally.
- Swob does not include product analytics or session-upload telemetry in the reviewed current source.
- Startup update checks contact the release service but do not send session content.
- Optional AI Insights sends bounded real session samples only after an explicit confirmation.
- API credentials are stored in the local Swob Library configuration and are **not encrypted by Swob** in current `main`.
- SSH resume and terminal resume contact only destinations/actions the user explicitly configures.

Read the complete boundaries in [PRIVACY.md](PRIVACY.md). Report vulnerabilities through [SECURITY.md](SECURITY.md), never through a public issue containing transcripts or credentials.

## Stable vs. next

| Channel | What it contains |
|---|---|
| **Stable v1.2.0** | Five-source browsing, lineage detection/registry, compact expansion, search, token insights, CLI, backup/export, and resume. Public DMGs are unsigned. |
| **Current `main` / next release** | Adds 11-harness ingestion, Session Galaxy, Execution Tree, Context Inspector, Session Audit, optional AI Insights, SQLite FTS5, and watcher/worker performance work. Build from source today. |

## Tech stack

Electron 40 · React 19 · TypeScript · Zustand · Tailwind CSS 4 · SQLite FTS5 · Recharts · electron-vite

## Contributing

Issues and pull requests are welcome. Before sharing a fixture or screenshot, remove transcript content, absolute paths, credentials, cookies, and device identifiers. Security reports follow [SECURITY.md](SECURITY.md).

## License

[AGPL-3.0-only](LICENSE). If you distribute a modified network-accessible version, review the AGPL obligations that apply to your use.
