# Swob brand source

`swob-logo-session-galaxy.png` is the single source consumed by
`scripts/generate-icons.mjs`.

- Design: Swob session galaxy with a lavender fork/resume lineage.
- Ownership: original Swob brand artwork, owned by the project; no third-party
  logo or stock asset is incorporated.
- Creation: AI-assisted image generation and owner-directed edits, finalized on
  2026-07-22.
- Canonical export: copied without pixel changes from the owner-designated
  `swob新logo/正式版/图标.png` on 2026-07-23. Its SHA-256 is
  `19b75ad0a6f5d85f054b045cacd0c112346b0823e31d992aece323c16fc33846`.
- The same 1024px bytes are present in the formal macOS iconset and iOS app icon
  set, which confirms this is the intended cross-platform master.

Do not hand-edit generated icons. Replace this source only with a formally
approved 1024px RGBA export that retains an 8–12% optical margin, then run:

```sh
npm run icons:generate
npm run icons:check
```
