# t156 · Logo replacement and application icon pipeline

Date: 2026-07-23

Branch: `chore/t156-logo-pipeline`

Result: **PASS — implementation and local acceptance complete; no release was published.**

## Outcome

Swob now derives every application and favicon asset from one checked-in brand
source:

`build/brand/swob-logo-session-galaxy.png`

The taskbook's original concept PNG is 1254×1254 but retains the wide white rim
that the owner later rejected. The vault also contains the subsequent
owner-approved `swob-app-icon-v3/icon.png`, documented as the current
transparent, zero-white-rim master. That approved 1024×1024 RGBA derivative is
therefore the canonical repository source. The pipeline changes neither its
node composition nor its lavender lineage; it only normalizes the visible
silhouette to an Apple-style 10% optical margin and derives platform sizes.

![Old airplane icon compared with the new Session Galaxy icon](assets/old-vs-new.png)

## Reproducible pipeline

`scripts/generate-icons.mjs` generates and checks 11 outputs:

| Consumer | Outputs |
| --- | --- |
| Electron/macOS | `build/icon.png`, `build/icon.icns` |
| Electron/Windows | `build/icon.ico` |
| GitHub Pages/docs | `site/assets/favicon-32.png`, `apple-touch-icon.png`, `favicon-512.png`, `favicon.svg` |
| Future website app | matching files under `website/public/` |

Commands:

```sh
npm run icons:generate
npm run icons:check
```

The generation command writes only changed files. `--check` regenerates all
expected bytes in memory and fails when any checked-in derivative is missing or
stale. `npm run check` now includes this gate.

Container inspection:

- ICNS PNG chunks: 16, 32, 64, 128, 256, 512 and 1024 px.
- ICO PNG entries: 16, 24, 32, 48, 64, 128 and 256 px.
- `iconutil` successfully decoded the generated ICNS.
- Master visible alpha bounds: 810×820 within a 1024×1024 canvas, with
  102–106 px edge margins (10% optical margin, allowing source asymmetry).
- A second generation produced the same aggregate SHA-256:
  `e62ffe193827db97138baf661cba7b30d83214ed7008cd6f39ad9b5210c4ab7d`.
- `site/assets/` and `website/public/` favicon hashes match at every size.

The SVG favicon is intentionally a deterministic raster-backed SVG wrapper:
there is no approved vector source, so auto-tracing would invent geometry and
weaken provenance. PNG sizes remain the authoritative raster derivatives.

## Packaged application acceptance

Command:

```sh
npm run build:mac:verify
```

The command produced an unsigned local verification build only:

- `dist/mac-arm64/Swob.app`
- `dist/swob-1.2.0-arm64.dmg`
- `dist/swob-1.2.0-arm64.zip`

`build/icon.icns`, the packaged app's
`Contents/Resources/icon.icns`, the copy inside the mounted DMG, and the DMG
`.VolumeIcon.icns` all had SHA-256:

`70f48127248168faf986ab9156b21211b0618c190e3c27ac20923c656a40b654`

### Finder

![Finder rendering the packaged Swob application](assets/finder-app.png)

### Mounted DMG

![Mounted DMG rendering the Swob application icon](assets/dmg-mounted.png)

### Dock

![Running packaged build in the macOS Dock](assets/dock.png)

### About panel

![macOS About panel with the Session Galaxy icon](assets/about.png)

All four native surfaces rendered the new icon. The lavender fork/resume line
remained recognizable in the About panel and Dock size; no white rim or opaque
square corner reappeared.

## Website acceptance

![Local GitHub Pages build using the new icon in the navigation](assets/site-home.png)

Playwright loaded the local site at 1440×900 and confirmed:

- the brand image completed with a 512×512 intrinsic size;
- `link[rel=icon]` resolves to the newly generated SVG;
- page `scrollWidth` equals `clientWidth` (no horizontal regression).

## Compliance

`compliance/t131/asset-provenance.csv` records the canonical source as an
original Swob project brand asset, AI-assisted and finalized by owner-directed
editing on 2026-07-22, with no third-party material. `build/brand/README.md`
records the source lineage and regeneration contract. Adding `sharp` as a
direct development dependency also regenerated `THIRD_PARTY_NOTICES`.

## Gates

| Gate | Result |
| --- | --- |
| `npm run icons:check` | PASS · 11 current files |
| `npm run check` | PASS |
| `npm test` | PASS · 925 passed / 11 skipped |
| `npm run build:mac:verify` | PASS |
| macOS `iconutil` decode | PASS |
| Native Dock/Finder/About/DMG inspection | PASS |
| Playwright website inspection | PASS |

The first full test run had one transient timeout in the unrelated
`library-create-concurrency.test.ts` multi-process lock test (924 passed, 1
failed). The isolated test then passed, and a clean full rerun passed 925/925.
No product code was changed to mask that race.

## Scope boundaries

- No product logic changed.
- No version bump, signing, notarization, upload or GitHub Release occurred.
- No `.bak` copy of the old icon was added; Git history remains the rollback
  mechanism.
