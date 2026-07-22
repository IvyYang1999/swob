# ProviderProtocol v1

`provider-protocol-v1.schema.json` is the only language-neutral type truth for
the provider wire envelope and canonical conversation graph.

## Generate and verify TypeScript

```bash
npm run schema:gen
npm run schema:check
```

The generated file is `src/shared/provider-schema.generated.ts`. Do not edit it
by hand. CI runs `schema:check` through `npm run check` so schema/type drift
fails closed.

## Ownership boundary

Providers may report source facts and provenance only:

- stable `SourceRef` identities for files, compound directories, SQLite rows,
  virtual members and import packages;
- sessions, messages, tool calls/results, usage, relationships and artifacts;
- parse status, typed errors, fingerprints, parser/format versions and
  tombstones.

Providers do **not** write Vault state, execute Resume, or decide user titles,
folders, tags, `LogicalSessionKey` or `packageId`. The Library host owns logical
identity and package bindings. A source-provided title is retained only as the
machine fact `providerTitle`.

`QueryFrame` is explicitly `lossy: true`. It is an analysis projection and is
never the canonical transcript store.

## Compatibility

Existing `SessionSource` values remain a closed compatibility union derived
from `LEGACY_SESSION_SOURCES`. New protocol providers use a namespaced string
such as `vendor/provider`; their conformance does not require adding a central
switch.

The fixtures are synthetic and contain no production transcripts or copied
third-party fixtures.
