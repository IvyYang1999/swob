# Swob

A desktop app for browsing, searching, and organizing your [Claude Code](https://docs.anthropic.com/en/docs/claude-code) sessions.

Claude Code stores every conversation as JSONL files on disk. Swob turns them into a visual, searchable archive — so you can revisit past sessions, find that one command you ran last week, and pick up right where you left off.

## Features

**Browse & Organize**
- Tree view with nested folders, drag-and-drop, and custom titles
- Three view modes: Compact (hide tool noise), Full (everything), and Markdown (exportable)
- Right sidebar shows session metadata, file operations, tool usage stats, and skill invocations

**Search**
- Global full-text search across all sessions (⌘K)
- In-session keyword search (⌘F) with precise highlighting and navigation
- Keywords inside collapsed compact sections or height-limited blocks are auto-revealed

**Highlight & Annotate**
- Select any text and click "Highlight" to bookmark it
- All highlights are listed in the right sidebar — click to jump back
- TOC entries with highlights get a green dot marker

**Resume Sessions**
- One-click resume in Terminal or iTerm2 (`claude --resume`)
- Batch resume multiple sessions at once
- Respects permission mode and working directory

**Library System**
- Auto-syncs from `~/.claude/projects/` via file watcher
- Each session gets a directory in `~/Documents/Swob/` with:
  - `transcript.md` — readable Markdown transcript
  - `backup.jsonl` — full conversation backup
  - `.swob-session.json` — metadata (title, notes, highlights)
- Native file drag-and-drop (drag a session to Finder, Notes, etc.)

## Install

### macOS (Apple Silicon / Intel)

Download the latest `.dmg` from [Releases](https://github.com/IvyYang1999/swob/releases).

### Build from Source

```bash
git clone https://github.com/IvyYang1999/swob.git
cd swob
npm install
npm run build
npm run build:mac    # produces .dmg in dist/
```

For development with hot reload:

```bash
npm run dev
```

## Requirements

- macOS (Electron, Apple Silicon or Intel)
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) installed (Swob reads its session files)

## Tech Stack

Electron + React 19 + TypeScript + Zustand + Tailwind CSS 4, built with electron-vite.

## License

[AGPL-3.0](LICENSE)
