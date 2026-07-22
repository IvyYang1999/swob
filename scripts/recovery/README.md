# Duplicate recovery inventory (read-only)

This operator tool inventories duplicate Swob session packages and emits evidence plus a future recovery plan. It never moves, merges, renames, overwrites, or deletes a package.

## Run

An explicit Library root is mandatory. Reports are written only to stdout.

```bash
npm run recovery:inventory -- --library /path/to/synthetic-library --format json
npm run recovery:inventory -- --library /path/to/synthetic-library --format markdown
```

Source hashing is opt-in because manifest source paths may point outside Library:

```bash
npm run recovery:inventory -- --library /path/to/synthetic-library --hash-sources
```

The suggested quarantine root defaults to a sibling of Library. To choose another location, it must remain outside Library:

```bash
npm run recovery:inventory -- \
  --library /path/to/synthetic-library \
  --quarantine-root /separate/protected/quarantine
```

Before acting in a separately reviewed future tool, verify that the plan has not expired:

```bash
npm run recovery:inventory -- \
  --library /path/to/synthetic-library \
  --verify-plan /protected/report.json
```

`current` means the rebuilt snapshot fingerprint still matches. Any package/file/source evidence change returns `expired`.

## Safety and privacy

- `--dry-run` is the only mode; there is no apply subcommand.
- The implementation imports t130’s `LogicalSessionKey` and registry conflict contract.
- Reports omit transcript bodies, title values, full source paths, Library paths, and source contents.
- Package-internal relative file names, sizes, mtimes, and hashes are included so unique attachments and branch transcripts remain reviewable.
- `canonical-candidate` requires byte-equivalent package content, semantic equality of every manifest field except package identity, and, with source hashing enabled, backups that match their declared sources.
- Divergent backups or user metadata/files become `merge-required`; corrupt, cloud-only, symlink, legacy, and otherwise unprovable cases fail closed.
- Quarantine suggestions contain a reverse map and point outside Library. They are plans only.
- Do not run against a real Library without separate user authorization. Real reports must remain local, gitignored, access-restricted, and out of mail/screenshots.

Schema: [`inventory.schema.json`](./inventory.schema.json).
