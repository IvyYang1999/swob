# t131 compliance tooling

These local-only tools reproduce the committed, privacy-filtered inventory and source-similarity evidence for the t131 Apache-2.0 relicensing audit. They do not change product code or license declarations and must not upload source or results.

## Baseline inventory

```sh
node scripts/compliance/t131-inventory.mjs \
  --repo . \
  --output-dir compliance/t131
```

This regenerates the anonymized git rights-chain summary, package-lock license inventory, tracked-asset provenance table and tracked-file scope inventory. It requires Node.js and Git. It reads public repository metadata and tracked files only.

Asset clearance is hash-bound by
`compliance/t131/asset-evidence-manifest.json`; path names alone never grant a
cleared disposition. The release-facing fail-closed check is:

```sh
npm run check:asset-evidence
```

Any new asset, byte drift, missing manifest member, or aggregate mismatch makes
that command fail until the evidence manifest is explicitly reviewed and
updated.

## Similarity scan

Prepare local, pinned checkouts from `compliance/t131/source-corpus.lock.json` and release-tag archives for v1.0.0, v1.1.0 and v1.2.0. Then run:

```sh
node scripts/compliance/t131-similarity.mjs \
  --target . \
  --corpus /absolute/local/corpus \
  --snapshot v1.0.0=/absolute/local/snapshots/v1.0.0 \
  --snapshot v1.1.0=/absolute/local/snapshots/v1.1.0 \
  --snapshot v1.2.0=/absolute/local/snapshots/v1.2.0 \
  --output /absolute/local/audit/similarity-raw.json
```

The tool performs exact-file, normalized 16-line, 80-token and TypeScript/JavaScript AST-subtree comparisons, then routes rare-term overlap to manual review. It writes no source snippets or literal values. Raw results stay outside Git; only the reviewed, sanitized `compliance/t131/similarity-summary.json` is committed.

The recorded run used Node.js 24.2.0 and TypeScript 5.9.3. `scripts/compliance/**`, dependencies, vendored/generated/build output, lockfiles, source maps, minified files and license/notice texts are excluded for the reasons recorded in the summary.

## Other recorded tools

- ScanCode Toolkit 32.5.0 was built locally from its official GitHub tag and run in Docker with license, copyright, package, info and classification scans. Raw JSON remains in the temporary local audit area.
- CycloneDX npm 4.1.1 generated the production and development CycloneDX 1.6 SBOMs with reproducible output and schema validation.
- DMG was mounted read-only; ZIP and NSIS payloads were extracted locally. No binary, source, asset or result was sent to an online scanner.

All committed summaries are evidence scoped to the recorded baseline, not legal advice.

## t154 packaging and notice gates

Generate or verify the lockfile-derived production notice inventory:

```sh
npm run notices:generate
npm run notices:check
```

Regenerate both SBOMs after `npm ls --package-lock-only --all` succeeds. The
script deliberately does not pass `--ignore-npm-errors`:

```sh
npm run sbom:generate
```

After electron-builder creates an unpacked application, inspect every
`app.asar` path and the outer notice files. A successful run writes the full,
sanitized path inventory under `dist/package-inventory/`; a rejected package
does not persist its inventory.

```sh
npm run check:package
npm run test:package-policy
```
