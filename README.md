<div align="center">

<img src="docs/banner.png" alt="Swob" width="100%" />

<p>
  <a href="README.md">English</a> | <a href="README.zh.md">中文</a> | <a href="README.ja.md">日本語</a> | <a href="CHANGELOG.md">Changelog</a>
</p>

<p>
  <img src="https://img.shields.io/badge/version-1.1.1-blue" alt="Version" />
  <img src="https://img.shields.io/badge/platform-macOS-lightgrey" alt="Platform" />
  <img src="https://img.shields.io/badge/built%20with-Electron-47848F" alt="Built with Electron" />
  <img src="https://img.shields.io/github/downloads/IvyYang1999/swob/total" alt="Downloads" />
  <img src="https://img.shields.io/badge/license-AGPL--3.0-green" alt="License" />
</p>

<h3>Browse, Search & Resume Your Claude Code Sessions</h3>

<p>
  The missing session manager for <strong>Claude Code</strong>, <strong>Codex</strong> & <strong>Cursor</strong>.<br/>
  Recover compacted conversations. Search across hundreds of sessions. Resume with one click.
</p>

</div>

<br/>

<p align="center">
  <img src="docs/screenshot.png" alt="Swob main interface" width="800" />
</p>

---

## The Problem

You've been vibe-coding from `~` for months. You have 200+ Claude Code sessions piled up with no organization. Half of them have been compacted — the original conversation is gone, replaced by a summary. The built-in `/resume` only shows recent sessions. Finding that one conversation where you solved a tricky bug? Good luck.

## The Solution

Swob reads the JSONL files that Claude Code, Codex, and Cursor store on disk. It parses every session, detects branches and continuations, **reconstructs the full pre-compact history**, and presents everything in a searchable, organized interface.

Your data stays 100% local. Swob never uploads anything.

---

## Key Features

### Recover Compacted Conversations

Claude Code compacts your conversation to save context. The original messages are still in the JSONL file — Swob finds them and lets you expand any compact block to read what was lost. **No other tool does this.**

### Spotlight Session Jump — `⌘⇧K`

A global hotkey brings up a Spotlight-style search window. Fuzzy search by content, project name, folder, or time (`today`, `yesterday`, `this week`). Filter by source (`claude`, `codex`, `cursor`). Jump to any session in under a second without switching windows.

### Full-text Search — `⌘K`

Search across all sessions at once. Matches auto-expand inside collapsed compact sections, so you find things even when they've been compacted away. In-session search (`⌘F`) with regex support.

### Multi-source: Claude Code + Codex + Cursor

Reads from `~/.claude/projects/`, `~/.codex/sessions/`, and `~/.cursor/projects/` — browse and resume sessions from all three tools in one place.

### Token Insights Dashboard

- 5 stat cards: total tokens, sessions, turns, active days, estimated time
- 365-day contribution heatmap (like GitHub, but for your AI usage)
- Source breakdown donut chart (Claude Code vs Codex vs Cursor)
- Model usage breakdown
- Project ranking by token consumption
- 30-day daily trend chart

### One-click Resume

Click any session to reopen it in Terminal or iTerm2. Batch-resume an entire folder. Working directory and `--dangerously-skip-permissions` mode are preserved. Supports Codex (`codex resume`) and Cursor (`cursor agent --resume`) too.

### SSH Remote Resume

Configure SSH connections and resume sessions on remote servers directly from the app.

### CLI — `swob`

```bash
swob search "auth bug"          # fuzzy search sessions
swob list --source codex        # filter by source
swob resume <id>                # get resume command
swob insights                   # token usage stats
swob active                     # show running sessions
swob install                    # install CLI + Agent Skill
```

All commands output JSON. The `swob install` command also installs a Claude Code Skill, so Claude can call `swob` as a tool during conversations.

### Session Organization

Tree-view sidebar with nested folders, drag-and-drop sorting, and custom titles. Three view modes: Compact (hide tool noise), Full (everything), Markdown (clean export).

### Branch Detection

Automatically detects when sessions continue from another file (multi-file continuations) and when concurrent branches diverge. Sidechain / rejected-plan branches are dimmed.

### Highlight & Annotate

Select any text to bookmark it. All highlights are collected in the right sidebar with jump-back links — your personal knowledge trail across sessions.

### Metadata Sidebar

Every session shows: creation/update time, turn count, token usage (input/output/cache), tool call stats, skill invocations, file operations tree, referenced files list, and estimated active time.

### iCloud Backup

Sessions are backed up to `~/Documents/Swob/` with readable Markdown transcripts. iCloud placeholder files are auto-detected and downloaded on demand.

### Active Session Detection

Green dot indicates which sessions are currently running. Detected via `ps` polling (1s interval) and file-change watchers.

### Drag-to-export

Every session is auto-exported as Markdown. Drag it into another app (Finder, Notes, another Claude Code session) to carry context across conversations.

### Bilingual UI

Full Chinese (zh-CN) and English support.

---

## Install

Download the latest `.dmg` from [**Releases**](https://github.com/IvyYang1999/swob/releases).

Or build from source:

```bash
git clone https://github.com/IvyYang1999/swob.git
cd swob
npm install
npm run dev          # development with hot reload
npm run build:mac    # produces .dmg in dist/
```

**Requirements:** macOS (Apple Silicon or Intel) · Claude Code installed

---

## Tech Stack

Electron 40 · React 19 · TypeScript · Zustand · Tailwind CSS 4 · Recharts · electron-vite

---

## Related

- [claude --resume](https://docs.anthropic.com/en/docs/claude-code) — Built-in session resume (limited to recent sessions)
- [CC Switch](https://github.com/farion1231/cc-switch) — Provider & config manager for AI CLI tools
- [awesome-claude-code](https://github.com/hesreallyhim/awesome-claude-code) — Curated list of Claude Code tools

---

## License

[AGPL-3.0](LICENSE)
