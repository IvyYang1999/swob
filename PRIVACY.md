# Swob Privacy Boundaries

Last reviewed against current `main`: 2026-07-23.

Swob is local-first, not network-free. Core session browsing and analysis stay on the Mac, while a small number of explicit features can use the network. This document states the boundary precisely so “local-first” is not mistaken for an unconditional offline guarantee.

## What Swob reads

Swob discovers local histories from supported agent locations, including:

- Claude Code and compatible roots such as `~/.claude/projects/`, Claude Window, and CC Mirror;
- Codex under `~/.codex/sessions/`;
- Cursor under `~/.cursor/` project storage;
- OpenCode and Zcode SQLite stores;
- Antigravity, Grok/Factory, Pi, Kimi Code, and Hermes local histories.

The exact metadata available depends on what each tool records. Session content may include prompts, model replies, tool inputs and outputs, file paths, working directories, images, errors, token usage, model identifiers, and timestamps.

## What Swob writes locally

By default, the Swob Library is `~/Documents/Swob/`. It may contain:

- local `backup.jsonl` copies of source sessions;
- readable Markdown transcripts;
- session and folder metadata;
- the lineage registry;
- application preferences and optional AI provider settings.

The SQLite FTS5 search index is stored separately at `~/.claude-session-manager/search.db` by default. It contains locally indexed message text and metadata needed for search.

Users can choose a different Library location. If that location is synced by iCloud or another filesystem provider, those files are subject to that provider's privacy and retention rules; Swob does not control them.

## Core local processing

These operations run locally in the reviewed current source:

- browsing and rendering transcripts;
- source detection and normalization;
- lineage reconstruction and graph layout;
- compact-history expansion;
- SQLite indexing and full-text search;
- execution-tree and context inspection;
- session audit and the non-LLM Quick Report;
- local exports and Library backups.

Swob does not include product analytics, advertising identifiers, or session-upload telemetry in the reviewed current source.

## Network activity

### Update checks

Swob can check the configured release service after startup. Automatic download is disabled; an update is downloaded only after the user chooses to do so. Update requests do not intentionally include session content.

### SSH public IP lookup

Opening SSH settings and refreshing the local connection information reads only the Mac's hostname, LAN addresses, Tailscale address, and local SSH status. Those actions do not contact `api.ipify.org`.

Swob contacts `https://api.ipify.org?format=json` only after the user explicitly clicks **Query public IP**. The lookup sends one HTTPS request with a five-second timeout. The service necessarily receives the request's source IP and ordinary request metadata, but Swob does not intentionally include session content, credentials, or Library data. The returned address is displayed locally and is not retained by Swob.

### Optional AI Insights

AI Insights is off until a user configures a provider credential and explicitly confirms generation. When invoked, current `main` sends the configured provider:

- locally computed aggregate metrics;
- samples from at most 60 recent sessions;
- at most 8 human user messages per sampled session;
- at most 300 characters from each sampled message;
- at most 120,000 characters of sampled content in total;
- source, turn-count, and date context used to interpret those samples.

System-generated messages and obvious system-reminder content are filtered, but this is not a guarantee that a user prompt contains no secrets, personal data, source code, or customer information. Review the provider's terms and do not enable AI Insights for sensitive libraries unless sending those samples is acceptable.

The provider, model, and optional base URL are user-controlled. A custom base URL sends data to that destination.

### Provider credentials

Current `main` stores the configured AI credential in the local Swob Library configuration (`.swob-config.json`). The settings UI masks the value after entry, but **the credential is not encrypted by Swob at rest**. Protect the macOS account and Library location accordingly. Do not sync that configuration into a shared or public location.

### Resume and remote actions

- Local resume opens a user-selected terminal and runs the source-specific command the user requested.
- SSH resume connects only to the host and account the user configured.
- Opening links or paths delegates to macOS or the chosen external application.

These actions can contact external systems because that is their explicit purpose; Swob does not classify them as background telemetry.

## Screenshots, reports, and issue attachments

Screenshots and generated reports can reveal prompts, code, file paths, usernames, hostnames, model names, errors, and usage patterns. Before sharing them:

1. use a sanitized demo library where possible;
2. remove credentials, cookies, tokens, private URLs, customer data, and machine identifiers;
3. crop or redact absolute paths and session IDs;
4. never attach `.swob-config.json`, raw environment files, or unreviewed transcripts to a public issue.

For a vulnerability involving sensitive content, follow [SECURITY.md](SECURITY.md).

## Data deletion and retention

Swob does not provide a hosted account or cloud-side copy to delete. Local retention is controlled by the source tools, the Swob Library, the search index, and any filesystem-sync provider used for those locations.

Deleting only an original agent session does not delete its Swob Library backup. Deleting only a Swob transcript does not delete the original session. Review every relevant local copy before treating data as removed.

## Stable release boundary

The planned public v1.3.0 release contains the features and privacy boundaries described above. It will be published only if its macOS installers pass Developer ID signing, notarization, stapling, and release-asset verification. The current public v1.2.0 release does not include optional AI Insights and its DMGs are unsigned; after v1.3.0 is published, v1.2.0 users must manually replace the app once to cross into the new signing trust root.

## Changes to this document

Any new telemetry, hosted service, crash reporting, network-backed analysis, or credential-storage mechanism must update this document in the same change before release.
