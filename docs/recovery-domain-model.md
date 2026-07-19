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

`deviceId` is a per-home installation UUID stored in
`~/.claude-session-manager/app-config.json`. It is not a hardware identifier and
must not be presented as proof that two records came from the same physical
machine. It is generated once when a local origin must first be captured. A new
Library item copies that UUID into
`origin.deviceId`; later sync/transcript updates preserve the first origin and
never replace it with the current installation.

First creation is serialized by an exclusive (`wx`) lock. Under that lock the
writer re-reads the configuration, writes a unique temporary file with `wx`, and
renames it to `app-config.json`. A concurrent initializer refuses instead of
creating a competing ID. A leftover lock is also refused rather than guessed to
be stale. Invalid JSON or invalid `libraryPath`/`deviceId` types are not
overwritten by identity creation.

Library-only discovery does not depend on identity creation succeeding. If the
config is corrupt or locked, `deviceId` is treated as missing: the backup remains
visible and loadable, while v2 metadata is conservatively marked as not proven
to belong to this installation. The original config and persisted session
origin are left untouched.

`origin.hostname` is the persisted display/SSH hint corresponding to the old
runtime `remoteHost` concept. Remote identity is derived from
`origin.deviceId !== localDeviceId`; hostname and username are not unique keys.
The existing `isRemote` UI field therefore means "not from this installation",
not "proven to be from another physical machine".

Two identity-drift cases are intentionally fail-closed:

- Cloning or migrating the whole home directory copies the ID. Both homes then
  compare as the same installation, so the current model cannot detect that they
  are now active on separate machines. It does not rotate automatically because
  that would break legitimate one-way migration. A future explicit
  "fork installation identity" flow must create a new local ID and preserve all
  historical `origin` fields for audit.
- Deleting `app-config.json` creates a new ID on the next successful local
  capture. Existing Library items from the old ID then compare as non-local and
  implicit recovery is refused; they do not disappear and their origins are not
  rewritten. A future reconciliation flow may let the user explicitly adopt or
  import them after inventory, never from hostname/username heuristics alone.

Legacy metadata without `schemaVersion`, `origin`, or `sourceInstance` remains
valid and receives no invented defaults merely by being read. If its original
source is demonstrably visible to the current installation, a normal metadata
update may lazily capture the local origin. With no such evidence, historical path/user
guessing remains unchanged and explicitly low confidence.

## Pure planner contract

`planSessionRecovery()` accepts only:

- requested logical session ID and Library metadata;
- a prevalidated backup descriptor (`ready`, `icloud-placeholder`, `invalid`,
  or `missing`), including the separately resolved physical ID when available;
- a caller-produced target-instance inventory, with explicit `trusted: boolean`
  and `existingFiles: [] | [...]` results (omission is not an empty inventory);
- an optional explicit target; v2 origin metadata also requires the local
  installation ID, and legacy implicit routing requires the local username.

It returns a target instance/type/path, logical and physical IDs, route,
predicted conflicts, and the exact logical backup paths that need iCloud
materialization. It refuses implicit restore for origins from another
installation, legacy paths encoding a different username, and non-standard
sources. It also refuses incomplete inventory, non-standard/untrusted targets,
and Claude Window targets without `configDir`. Existing target paths and
duplicate physical IDs are blocking conflicts.

Conflict comparison case-folds normalized paths and physical IDs to model the
default case-insensitive APFS behavior. This is a conservative lexical
approximation: it applies NFC plus JavaScript lowercase, but does not discover a
volume's actual case-sensitivity, resolve symlinks, or reproduce every APFS
Unicode edge case. The inventory adapter must still validate the real target
volume and trusted roots before setting `trusted: true`.

The module imports no filesystem API. It performs lexical path classification
only; trusted-root, symlink, existence, validation, and iCloud state facts must
come from an external read-only inventory adapter.

## Synthetic fixtures

`src/main/__fixtures__/resume-recovery-synthetic.ts` contains four visibly
redacted shapes: normal, logical/physical double ID, malformed line status, and
iCloud placeholder metadata. All names and paths use synthetic `xx…last4`
markers; no transcript text, real host/user identity, or credential is included.
