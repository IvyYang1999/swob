<div align="center">

<h1>Swob</h1>

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

<p><strong>AI forgets (compact). You don't.</strong></p>

<p>The session manager for Claude Code, Codex & Cursor — browse, search, recover, and resume any conversation.</p>

<img src="e2e/screenshots/chat-loaded.png" alt="Swob main interface" width="800" />

</div>

---

## Why Swob

Claude Code compacts conversations to save context. When that happens, your original messages are gone — you can only see the summary. **Swob keeps everything.**

Beyond recovery, Swob is a full control center for your AI coding workflow: organize hundreds of sessions into folders, jump to any conversation with a Spotlight-style shortcut, track token costs, and resume from your phone over SSH.

---

## Features

### 🔓 Pre-compact Recovery
Expand any compacted section to read the original messages. The only tool that does this.

### ⚡ Spotlight Session Jump (⌘⇧K)
Fuzzy search across all sessions. Jump to any conversation in under a second.

### 📁 Session Browser & Organizer
Tree-view sidebar with nested folders, drag-and-drop, custom titles, and branch detection. Three view modes: Compact / Full / Markdown.

### 🔀 Multi-source Support
Reads sessions from **Claude Code**, **Codex**, and **Cursor CLI** — all in one place.

### 📊 Token Insights
365-day heatmap, cost breakdown by model, project rankings, and daily timeline. Know exactly where your tokens go.

### ▶️ One-click Resume
Resume any session in Terminal or iTerm2 with a single click. Batch-resume entire folders. Working directory and `--dangerously-skip-permissions` mode are preserved automatically.

### 🌐 SSH Remote Resume
Configure SSH connections and resume sessions on remote servers directly from the app.

### 💻 CLI (`swob`)
```bash
swob search "authentication bug"     # search sessions
swob list --source claude            # list by source
swob resume <sessionId>              # get resume command
swob insights                        # token stats
swob active                          # show active sessions
swob install                         # install CLI + Skill
```

### 🔍 Full-text Search
Global search (⌘K) across all sessions, in-session search (⌘F) with regex support. Matches auto-expand inside collapsed compact sections.

### 🖊️ Highlight & Annotate
Select any text to bookmark it. All highlights are collected in the sidebar as a personal knowledge trail with jump-back navigation.

### ☁️ iCloud Sync
Backup sessions to `~/Documents/Swob/` (iCloud-synced). Auto-detects and downloads iCloud placeholder files on demand.

### 🌏 Bilingual UI
Full Chinese (zh-CN) and English support.

---

## Screenshots

<table>
  <tr>
    <td align="center"><b>Session Browser</b></td>
    <td align="center"><b>Chat View</b></td>
    <td align="center"><b>Global Search</b></td>
  </tr>
  <tr>
    <td><img src="e2e/screenshots/sidebar-loaded.png" alt="Session browser" /></td>
    <td><img src="e2e/screenshots/chat-loaded.png" alt="Chat view" /></td>
    <td><img src="e2e/screenshots/search-opened.png" alt="Global search" /></td>
  </tr>
</table>

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

## How It Works

Swob reads the JSONL conversation logs that Claude Code, Codex, and Cursor store on disk. It parses session files, detects multi-file continuations and branches, reconstructs pre-compact history, and presents everything in a visual interface. Your data stays local — Swob never uploads anything.

---

## Tech Stack

| | |
|---|---|
| Framework | Electron 40 + React 19 + TypeScript |
| Build | electron-vite |
| State | Zustand |
| UI | Tailwind CSS 4 |
| Charts | Recharts |
| Testing | Vitest + Playwright |

---

## Related

- [claude --resume](https://docs.anthropic.com/en/docs/claude-code) — Built-in session resume (limited to recent sessions)
- [awesome-claude-code](https://github.com/hesreallyhim/awesome-claude-code) — Curated list of Claude Code tools

---

## License

[AGPL-3.0](LICENSE)
