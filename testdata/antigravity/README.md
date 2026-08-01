# Antigravity synthetic evidence pack

Every value in this directory is synthetic. The UUIDs, workspace path, prompts,
tool payloads, model name, artifact text, and token counts do not come from a
real user or an Antigravity installation.

The JSONL shape is independently constructed from Google's documented
`transcript.jsonl` location and the pinned MIT reference implementations listed
in `compliance/third-party-static-notices.json`. It exists to verify parsing and
Provider Protocol v2 conformance; it is not presented as an upstream golden
file.

The SQLite fixture is constructed in `antigravity-provider.test.ts` from the
synthetic values in `known-sqlite-usage.json` and a synthetic schema/protobuf
payload. `agy-help.txt` is synthetic CLI help used only to exercise the
fail-closed `--conversation` capability check. No binary database or encrypted
`.pb` file is checked in.
