# Security Policy

## Reporting a vulnerability

Please use [GitHub's private security advisory form](https://github.com/IvyYang1999/swob/security/advisories/new) for vulnerabilities that could expose session content, credentials, local files, resume commands, remote hosts, or update integrity.

Do **not** open a public issue containing:

- API keys, tokens, cookies, SSH material, or environment files;
- raw transcripts or Swob Library configuration;
- private repository paths, customer data, hostnames, or device identifiers;
- a working exploit before a fix or mitigation is available.

If the advisory form is unavailable, open a minimal public issue asking for a private contact channel. Do not include the sensitive details in that issue.

## What to include

Provide the smallest safe reproduction:

- affected Swob version or commit;
- macOS and CPU architecture;
- affected source harness;
- expected and observed behavior;
- security impact;
- sanitized reproduction steps or a synthetic fixture;
- whether the issue requires AI Insights, SSH, resume, updater, or Library sync.

Replace real prompts, paths, IDs, credentials, and remote addresses with synthetic values before attaching logs or screenshots.

## Supported versions

| Channel | Security status |
|---|---|
| Latest public release | Receives release-level fixes when a supported patch is available. |
| Current `main` | Active development; fixes may land here before the next signed release. |
| Older releases | Upgrade is recommended; backports are not guaranteed. |

Public v1.2.0 DMGs are not signed or notarized. A signing/notarization smoke workflow has passed, but that does not retroactively change existing public assets.

## Security-sensitive boundaries

Swob processes untrusted or semi-trusted local history files. High-risk areas include:

- JSON, JSONL, SQLite, Markdown, image, and tool-output parsing;
- rendering links, code, images, and tool results from transcripts;
- backup and recovery writes into source-tool directories;
- construction and launch of local or SSH resume commands;
- update download and installation;
- optional AI Insights content sampling and provider requests;
- storage of AI provider credentials in local configuration.

Security fixes should preserve these rules:

1. never execute transcript content as a command;
2. validate paths and identifiers at the boundary that writes or resumes;
3. fail closed when a recovery target, lineage edge, or resume destination cannot be verified;
4. label estimated or unavailable data instead of inventing certainty;
5. keep secrets and real transcripts out of tests, logs, screenshots, and fixtures;
6. require explicit user action before sending session content to an external AI provider.

## Dependency and build reports

Reports about a vulnerable dependency should explain whether the vulnerable path is reachable in Swob. Build or release reports should identify the affected artifact and integrity risk without publishing credentials or signing material.

## Disclosure

Please allow reasonable time for investigation, mitigation, and release before public disclosure. The maintainer will coordinate credit and disclosure timing through the private advisory when possible.
