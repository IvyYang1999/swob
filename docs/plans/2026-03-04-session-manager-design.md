# Claude Session Manager - Design Document

## Overview

Electron desktop app for managing Claude Code sessions. Solves three pain points:
1. Compacted conversations lose pre-compact content in UI (but data exists in JSONL)
2. `/resume` list limited to ~50 sessions
3. No full-text search across session content

## Architecture

```
Electron Main Process
├── SessionLoader    — parse JSONL files, extract metadata
├── FileWatcher      — chokidar watches ~/.claude/projects/
├── TerminalLauncher — osascript opens Terminal/iTerm with `claude --resume`
├── ConfigStore      — read/write user folders/tags to config.json
│
│  IPC (contextBridge)
│
Renderer Process (React + TypeScript + Tailwind)
├── Sidebar          — folder tree + session list
├── ChatViewer       — message display (compact/full modes)
├── InfoPanel        — session metadata panel
└── SearchPanel      — global full-text search
```

## Data Sources

### Session Data (read-only)
- Path: `~/.claude/projects/*/*.jsonl`
- Format: one JSON object per line (append-only)
- Message types: `user`, `assistant`, `system`, `progress`, `file-history-snapshot`
- System subtypes: `compact_boundary`, `stop_hook_summary`, `turn_duration`
- Key fields per message: `sessionId`, `timestamp`, `cwd`, `version`, `type`, `message`, `slug`
- Pre-compact messages preserved before `compact_boundary` line

### User Config (read-write)
- Path: `~/.claude-session-manager/config.json`
- Contains: folders, session notes, custom titles, UI preferences
- Never modifies Claude Code's original JSONL files

## Data Model

```typescript
interface Session {
  id: string;
  slug: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  turnCount: number;
  compactCount: number;
  cwds: string[];
  version: string;
  firstUserMessage: string;
  messages: Message[];
  toolUsage: Record<string, number>;
  skillInvocations: SkillInvocation[];
  claudeMdContent?: string;
  projectPath: string;
}

interface Message {
  uuid: string;
  type: 'user' | 'assistant' | 'system' | 'progress';
  subtype?: string;
  timestamp: string;
  content: string | ContentPart[];
  toolCalls?: ToolCall[];
  isPreCompact: boolean;
}

interface ToolCall {
  name: string;
  input: Record<string, unknown>;
}

interface SkillInvocation {
  skillName: string;
  timestamp: string;
  args?: string;
}

interface Folder {
  id: string;
  name: string;
  sessionIds: string[];
  color?: string;
  createdAt: string;
}

interface UserConfig {
  folders: Folder[];
  sessionMeta: Record<string, {
    customTitle?: string;
    notes?: string;
  }>;
  preferences: {
    defaultViewMode: 'compact' | 'full';
    terminalApp: 'Terminal' | 'iTerm2';
  };
}
```

## UI Layout

Three-column layout:

```
┌──────────────────────────────────────────────────────────────────────┐
│  🔍 [全文搜索...]    [日期筛选▾] [目录筛选▾]  [精简/完整]  [▶ Resume] │
├────────────┬──────────────────────────────────┬──────────────────────┤
│  Sidebar   │       Chat Viewer                │    Info Panel        │
│  240px     │       flex-1                     │    280px             │
│            │                                  │                     │
│ Folders &  │  User/Assistant messages         │ Session metadata    │
│ Session    │  Tool calls (collapsible)        │ Working dirs        │
│ List       │  Compact boundary marker         │ Tool/Skill stats    │
│            │  Keyword highlighting            │ CLAUDE.md content   │
│            │                                  │                     │
├────────────┴──────────────────────────────────┴──────────────────────┤
│  Status bar: session count · disk usage · watcher status            │
└──────────────────────────────────────────────────────────────────────┘
```

### Sidebar
- Tree structure: Folders → Sessions
- "All Sessions" virtual folder at top
- "Ungrouped" section for unassigned sessions
- Each session card: title (first user msg), time, message count
- Drag-drop to assign sessions to folders
- Right-click context menu: rename, move to folder, delete folder
- Sessions can belong to multiple folders (tag-like)

### Chat Viewer
- Two modes toggled by button:
  - **Compact mode** (default): user + assistant text only, tool calls collapsed
  - **Full mode**: all messages including tool_use, tool_result, system
- Compact boundary shown as divider with different background
- Search keyword highlighting in messages

### Info Panel
- Creation time, last modified time
- Conversation turns count
- Compact count
- Claude Code version
- All working directories used
- .claude doc content (extracted from system messages)
- Tool usage breakdown (bar chart or list)
- Skill invocation log with timestamps
- (Future) KeyKeeper API key tracking

## Key Features

### Full-text Search
- Searches all messages across all sessions (including pre-compact)
- Results: matched snippet + session title + timestamp
- Click result → navigate to session and scroll to message
- Implementation: in-memory RegExp over loaded messages (sufficient for ~100 sessions)

### One-click Resume
- Resume button on each session + in toolbar
- Opens system terminal via osascript (AppleScript)
- Supports Terminal.app and iTerm2 (configurable)
- Command: `claude --resume <session-id>`
- Folder "Open All": opens each session in separate terminal tab

### Folder Management
- Create/rename/delete folders
- Drag-drop sessions into folders
- One session can be in multiple folders
- Folder data stored in config.json (independent of JSONL)
- Folder-level actions: open all, export all

## Tech Stack

| Layer | Choice | Reason |
|-------|--------|--------|
| Desktop | Electron 33+ | Mature, full Node.js access |
| Build | electron-vite | Fast HMR, good DX |
| Frontend | React 19 + TypeScript | Standard choice |
| Styling | Tailwind CSS 4 | Rapid UI development |
| State | Zustand | Lightweight, simple |
| File watch | chokidar | Reliable fs watching |
| Terminal | osascript | macOS terminal integration |
| Icons | Lucide React | Clean icon set |

## Performance Considerations

- Stream-parse JSONL files (readline) to avoid loading entire file into memory
- Lazy-load message content: load metadata first, full messages on session select
- FileWatcher only triggers re-parse for new/modified files
- Search runs in Web Worker to keep UI responsive
- ~95 sessions / 724MB total is well within Electron's capability
