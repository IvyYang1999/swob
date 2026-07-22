<div align="center">

<img src="site/assets/favicon.svg" alt="Swob" width="72" height="72" />

# Swob

### A git graph for your AI conversations

**Recover lost context. Trace forks and compactions. Debug how your agents actually worked.**

Swob parses local histories through **5 native-format adapters** and 1 Claude-compatible format. It can also detect files from 5 experimental sources without reading their message bodies. Where a source exposes the evidence, Swob adds lineage, incremental SQLite FTS5 search, execution inspection, provenance-aware audit, and optional AI Insights.

[Website](https://ivyyang1999.github.io/swob/) · [Verified releases](https://github.com/IvyYang1999/swob/releases) · [Changelog](CHANGELOG.md)

[English](README.md) · [中文](README.zh.md) · [日本語](README.ja.md)

![Latest release](https://img.shields.io/github/v/release/IvyYang1999/swob?label=stable)
![Platform](https://img.shields.io/badge/platform-macOS-2d2d30)
![Build](https://img.shields.io/github/actions/workflow/status/IvyYang1999/swob/release.yml?label=release)
![Downloads](https://img.shields.io/github/downloads/IvyYang1999/swob/total)
![License](https://img.shields.io/badge/license-AGPL--3.0-5b4fc4)

</div>

> [!IMPORTANT]
> **Product channels are intentionally separated.** The feature images below are English demo reconstructions based on current `main`; identifying text and sample data were localized and privacy-sanitized for publication. They show implemented layouts and workflows, not untouched production-data captures. Counts inside the images are illustrative and separate from the audited corpora below. The public **v1.2.0 stable DMGs predate Session Galaxy, multi-harness ingestion, Session Debugger, AI Insights, and SQLite FTS5**. Build `main` from source to try them; no unreleased feature is promised for a specific future installer here.

![English demo reconstruction of the Swob Session Galaxy in current main](site/assets/graph-view.png)

<p align="center"><sub>Current <code>main</code> · English demo reconstruction · privacy-sanitized illustrative data</sub></p>

## Why Swob exists

AI coding sessions are not isolated chat files. A resume creates another file. A fork splits a task. A compaction replaces earlier context with a summary. Different agents store the same kind of work in incompatible locations. A normal viewer can show one transcript; it cannot explain where that transcript came from or why the agent lost the plot.

Swob treats session history as evidence:

- **Trace lineage** — navigate verified fork and continuation relationships in an interactive, force-directed Session Galaxy.
- **Recover context** — expand compacted Claude Code turns and preserve local backups after the source has disappeared.
- **Debug execution** — inspect tool/agent calls, token pressure, compaction boundaries, latency, framework overhead, errors, and anti-patterns.
- **Search parsed histories** — SQLite FTS5 indexes normalized messages incrementally. Detection-only sources are excluded, and source-specific search gaps stay visible.
- **Resume safely** — return to a supported CLI with its session ID and working directory, with source-aware validation.

## Evidence, not vanity metrics

| Audited result | What it means |
|---|---|
| **253 / 1,621** | 253 Claude Code source sessions in one audited library were already missing under the default 30-day retention policy; Swob still had local backups. |
| **93.58%** | Verified resumability in the same 1,621-session, five-source audit corpus. This is an observed corpus result, not a universal success guarantee. |
| **1,704 sessions** | Current local performance and UI corpus used to exercise the new index and dashboard. |
| **5+1+5 sources** | Current `main` natively reads 5 harnesses, supports 1 compatible format, and experimentally detects 5 more (file discovery only, content reading not yet implemented). |

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

### Native-format adapters (5) — transcript parsing is available; other capabilities vary

| Source family | Status | Notes |
|---|---|---|
| Claude Code | Native | Transcript, search, usage, live watch, lineage, and terminal resume are available; desktop import is experimental. |
| Codex | Native | Transcript, search, usage, live watch, lineage, terminal resume, and native resume are available. |
| Cursor | Native | Transcript, live watch, and terminal resume are available; search is experimental; usage, lineage, and a native deep link are unavailable. |
| OpenCode | Native | Transcript, usage, archive, and terminal resume are available; search is experimental; live watch, lineage, and a native deep link are unavailable. |
| Zcode | Native | Transcript, usage, and archive are available; search and its workspace-opening deep link are experimental; live watch and terminal resume are unavailable. |

### Compatible format (1)

| Source family | Status | Notes |
|---|---|---|
| CC Mirror | Compatible | Claude-compatible transcript, search, and usage are available; live watch and archive are unavailable; terminal resume is experimental. |

### Experimental detection (5) — file discovery only, content reading not yet implemented

| Source family | Status | Notes |
|---|---|---|
| Antigravity | Experimental | Can discover local transcript files. |
| Grok / Factory | Experimental | Can discover JSONL history files. |
| Pi | Experimental | Can discover local session files. |
| Kimi Code | Experimental | Can discover local `wire.jsonl` files. |
| Hermes | Experimental | Can discover local JSON session files. |

> **Accuracy note:** “Native-format adapter” means transcript parsing is implemented, not that every capability is available. Search, usage, lineage, live watch, archive, and resume vary by source. “Experimental detection” means Swob can find files and show metadata-only placeholders, but cannot read or index their message bodies. The canonical matrix is [`src/shared/provider-capabilities.ts`](src/shared/provider-capabilities.ts).

## How Swob compares

Public README claims checked on 2026-07-21. `✅` = explicitly documented; `◐` = adjacent or partial capability; `—` = not documented as a current feature. This is a capability map, not a quality score.

| Capability | Swob current `main` | [Claude Code History Viewer](https://github.com/jhlee0409/claude-code-history-viewer) | [Agent Sessions](https://github.com/jazzyalex/agent-sessions) | [SessionView](https://github.com/tyql688/sessionview) |
|---|---|---|---|---|
| Local multi-harness history | ✅ 5 native + 1 compatible + 5 experimental | ✅ 9 providers | ✅ 9+ agents | ✅ 9 tools |
| Visual session lineage graph | ✅ verified + grouping edges | ◐ Session Board, not lineage | — | ◐ child-session normalization, no lineage graph documented |
| Compact-history recovery | ✅ Claude Code | — | — | — |
| Execution tree / agent-call anatomy | ✅ | ◐ tool rendering | ◐ tool/output navigation | ◐ tool-call mix and child sessions |
| Context pressure inspector | ✅ per-turn categories + compact boundaries | ◐ token analytics | ◐ quota/session runway | ✅ session context/cache analytics |
| Provenance-aware health audit | ✅ | — | ◐ honest quota states | — |
| Local full-text search | ✅ SQLite FTS5 for parsed sources; source status varies | ✅ | ✅ local index | ✅ SQLite FTS5 |
| Resume in source CLI | ✅ where supported | ◐ open/focus by session | ✅ supported CLIs | ✅ where supported |
| Headless / browser mode | — | ✅ | — | ✅ |

## Install

### Public installers

[GitHub Releases](https://github.com/IvyYang1999/swob/releases) is the truth source for the current version, supported architectures, signatures, and immutable asset names. This README deliberately does not synthesize or permanently fall back to an installer URL.

> At the 2026-07-23 audit, the public baseline was v1.2.0 for Apple Silicon and Intel Mac.

**System requirement:** macOS on Apple Silicon or Intel.

> [!WARNING]
> The public v1.2.0 DMGs are **not signed or notarized**. The signing pipeline has passed an isolated smoke test, but no signed public release exists yet. If Gatekeeper reports that Swob is damaged or cannot be opened, verify the download came from this repository, then run:
>
> ```bash
> xattr -cr /Applications/Swob.app
> ```

> [!IMPORTANT]
> **One manual migration will be required.** Because v1.2.0 predates the Developer ID trust root, it cannot safely auto-update into the first signed release. When that release ships, download the matching DMG from this repository and overwrite Swob once. Signed releases after that migration will use an isolated, E2E-gated update channel.

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
| **Current `main` / unreleased** | Adds multi-harness ingestion (5 native + 1 compatible + 5 experimental detection), Session Galaxy, Execution Tree, Context Inspector, Session Audit, optional AI Insights, SQLite FTS5, and watcher/worker performance work. Build from source today. |

## Tech stack

Electron 40 · React 19 · TypeScript · Zustand · Tailwind CSS 4 · SQLite FTS5 · Recharts · electron-vite

## Contributing

Issues and pull requests are welcome. Before sharing a fixture or screenshot, remove transcript content, absolute paths, credentials, cookies, and device identifiers. Security reports follow [SECURITY.md](SECURITY.md).

## License

[AGPL-3.0-only](LICENSE). If you distribute a modified network-accessible version, review the AGPL obligations that apply to your use.
