# Pricing candidate workflow

Swob has two deliberately separate price-catalog states:

- `src/main/pricing-snapshots.json` contains only immutable, approved runtime snapshots.
- `pricing/candidates/pending-review.json` is a content-addressed candidate. Its status is
  `pending-review` and `review.activationAllowed` must remain `false` until yyt/负责人 signs it.

Generate a candidate from local upstream clones:

```bash
npm run pricing:candidate -- \
  --genai /path/to/genai-prices \
  --litellm /path/to/litellm \
  --at 2026-08-02T00:00:00Z \
  --models-dev-revision <commit>
```

The importer reconstructs price intervals from the full `genai-prices` Git history. LiteLLM is
used only for coverage differences and pending Alibaba candidates; those numbers are labelled
`source: litellm`, retain the exact commit, and are never represented as official prices.
Every token candidate also carries the provider's official review URL.

The weekly workflow uploads `pending-review.json` and `drift-report.json` as CI artifacts. It never
edits the approved runtime snapshot. A reviewer must check each pending rule against its
`officialReviewUrl`, sign a new immutable snapshot, and only then change runtime activation.

Historical comparison is similarly explicit: call `previewUsageEventCandidateRepricing` or
`previewUsageEventsCandidateRepricing`. Normal `valueUsageEvent` rejects a pending candidate.
