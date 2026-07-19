# Recovery domain model (t089a)

This change defines recovery metadata and planning only. It does not copy,
publish, remove, or validate a Claude session file. Runtime materialization,
strict JSONL validation, locking, and atomic publication belong to later tasks.

## Session origin persistence

`.swob-session.json` keeps the existing required fields and adds optional v2
fields:

```ts
schemaVersion?: 2
origin?: {
  deviceId: string
  hostname: string
  username: string
  capturedAt: string
}
sourceInstance?: {
  kind: 'claude-default' | 'claude-window' | 'other'
  configDir?: string
}
```

`deviceId` is a per-install UUID stored in
`~/.claude-session-manager/app-config.json`. It is generated once when a local
origin must first be captured. A new Library item copies that UUID into
`origin.deviceId`; later sync/transcript updates preserve the first origin and
never replace it with the current machine.

`origin.hostname` is the persisted display/SSH hint corresponding to the old
runtime `remoteHost` concept. Remote identity is derived from
`origin.deviceId !== localDeviceId`; hostname and username are not unique keys.

Legacy metadata without `schemaVersion`, `origin`, or `sourceInstance` remains
valid and receives no invented defaults merely by being read. If its original
source is demonstrably present on the current machine, a normal metadata update
may lazily capture the local origin. With no such evidence, historical path/user
guessing remains unchanged and explicitly low confidence.

## Pure planner contract

`planSessionRecovery()` accepts only:

- requested logical session ID and Library metadata;
- a prevalidated backup descriptor (`ready`, `icloud-placeholder`, `invalid`,
  or `missing`), including the separately resolved physical ID when available;
- a caller-produced target-instance inventory, including existing files;
- optional explicit target and local device ID.

It returns a target instance/type/path, logical and physical IDs, route,
predicted conflicts, and the exact logical backup paths that need iCloud
materialization. It refuses implicit restore for known remote origins and
non-standard sources, refuses non-standard/untrusted targets, and treats an
existing target path or duplicate physical ID as a blocking conflict.

The module imports no filesystem API. It performs lexical path classification
only; trusted-root, symlink, existence, validation, and iCloud state facts must
come from an external read-only inventory adapter.

## Synthetic fixtures

`src/main/__fixtures__/resume-recovery-synthetic.ts` contains four visibly
redacted shapes: normal, logical/physical double ID, malformed line status, and
iCloud placeholder metadata. All names and paths use synthetic `xx…last4`
markers; no transcript text, real host/user identity, or credential is included.
