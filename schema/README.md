# ProviderProtocol v1 and v2

Provider Protocol v2 is the canonical ordered fact stream. Its language-neutral
truth is `provider-protocol-v2.schema.json`; validation order and per-chunk
budgets live in `provider-protocol-v2.conformance.json`. Generated TypeScript is
`src/shared/provider-schema-v2.generated.ts`.

v2 deliberately separates five identities that v1 could conflate:

- `physicalSourceId`: the observed file/row/container;
- `logicalSessionKey`: the t130 Library identity;
- `branchViewId`: one view through a logical session tree;
- `sharedEventKey`: the same event visible from multiple branch views;
- `billingFactKey`: one chargeable fact, independent of event duplication.

`CanonicalEvent.sequence + messageBlockIndex` preserves text/thinking/tool
ordering. Every event remains in the archive timeline; `timeline.modelContext`
records when it was model-visible, archived, or unknown. Unknown upstream facts
use the typed `unknown` event rather than disappearing.

Usage v2 stores aggregation mode, total/subset relations, measurement source and
confidence, de-duplication/billing keys, provider cost and price revision before
any sum is calculated. Tool handling is a three-layer registry: provider alias,
semantic tool, then presentation. Interaction/permission events carry historical
or live-pending state explicitly.

Transport uses ordered `parse-chunk` envelopes. Each envelope keeps the 1 MiB
untrusted-input safety budget, but a session has no envelope-count or total-event
limit. Cursor, chunk index and event sequence are checked before storage.

Provider v1 remains a compatibility input. The current Pi runtime still emits a
strict v1 `ParseOutcome`; `ProviderHost` validates it, migrates manifest and
records to validated v2 envelopes, then the canonical store dual-writes v1 and
v2. This is a boundary migration, not an in-place reinterpretation of v1.

## ProviderProtocol v1 compatibility

`provider-protocol-v1.schema.json` remains the language-neutral type truth for
the provider wire envelope and canonical conversation graph.
`provider-protocol-v1.conformance.json` is the matching machine-readable truth
for validation order, resource limits and non-wire schema migrations. The
generated TypeScript contract consumes both files; runtime code must not define
a second set of protocol semantics or limits.

## Generate and verify TypeScript

```bash
npm run schema:gen
npm run schema:check
```

The generated files are `src/shared/provider-schema.generated.ts` and
`src/shared/provider-schema-v2.generated.ts`. Do not edit them by hand. CI runs
`schema:check` through `npm run check` so schema/type drift fails closed.

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

## Versions and migration

- The ProviderEnvelope wire protocol remains `1.0`. Existing envelopes that
  satisfy the stricter v1 schema remain compatible; unknown or future wire
  versions are rejected instead of guessed.
- Conformance contract `1.1.0` makes invalid state combinations fail closed:
  empty successful parses require the typed `no-data` outcome, partial results
  require typed errors, replacement requires a target, unavailable usage must
  not contain synthetic zero totals, and stable source IDs must not disclose an
  absolute local path.
- QueryFrame schema v1 is intentionally rejected. A producer must emit schema
  v2: replace positional `fields`/array rows with rows keyed by field name whose
  cells carry `type`, `nullable` and `value`; set `lossy: true`; and include
  projection `status`, provenance, typed errors and an unavailable reason.
- UsageFact SQLite schema v4 combines event-day activity evidence with persisted
  per-session Provider outcomes. This index is a disposable local projection and
  is rebuilt from session facts on version mismatch; transcripts, Provider
  sources and Library identity are never migrated or rewritten by that rebuild.

Consumers should pin both `PROVIDER_PROTOCOL_VERSION` and
`PROVIDER_CONFORMANCE_VERSION`. A wire-version change requires a new protocol
schema. A conformance-version change may tighten validation while keeping the
wire discriminator unchanged and therefore must be reviewed before upgrading.

## Validation order and resource limits

Untrusted JSON is checked in this order: encoded envelope bytes, a non-recursive
lexical JSON budget, JSON decoding, a non-recursive value budget, then Draft
2020 schema validation with Ajv `strict: true`. A limit violation is the typed
`resource-limit-exceeded` Provider error; it is not retried or partially parsed.

The generated limits for conformance `1.1.0` are:

| Limit | Value |
| --- | ---: |
| Envelope bytes | 1,048,576 |
| JSON depth | 64 |
| Nodes | 50,000 |
| String UTF-16 code units | 262,144 |
| Items in any array | 10,000 |
| Properties in any object | 256 |
| Records per session | 10,000 |
| Sessions per outcome | 5,000 |
| QueryFrame rows | 10,000 |
| QueryFrame columns | 256 |

Change the values only in `provider-protocol-v1.conformance.json`, regenerate,
and commit the schema check result. Runtime parsers consume the generated
constants so documentation, tests and enforcement cannot drift independently.
