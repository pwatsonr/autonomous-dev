# SPEC-034-1-02: Self-host Inter and JetBrains Mono WOFF2 fonts

## Metadata
- **Parent Plan**: PLAN-034-1-tokens-and-theme
- **Parent TDD**: TDD-034-portal-redesign-foundations
- **Parent PRD**: PRD-018-portal-visual-redesign
- **Estimated effort**: 1 hour
- **Dependencies**: []
- **Priority**: P0

## Objective

Vendor 8 WOFF2 font files (Inter 400/500/600/700 and JetBrains Mono 400/500/600/700) into `plugins/autonomous-dev-portal/server/static/fonts/`, plus the OFL license texts, so the portal's `@font-face` declarations resolve under the existing strict CSP `font-src 'self'` (TDD-034 §5.4, §10.1; resolves PRD-018 OQ-06). No CSP changes; no runtime CDN dependency.

## Acceptance Criteria

- [ ] AC-01: Directory `plugins/autonomous-dev-portal/server/static/fonts/` exists.
- [ ] AC-02: Exactly 8 WOFF2 files are committed: `inter-v18-latin-400.woff2`, `inter-v18-latin-500.woff2`, `inter-v18-latin-600.woff2`, `inter-v18-latin-700.woff2`, `jetbrains-mono-v18-latin-400.woff2`, `jetbrains-mono-v18-latin-500.woff2`, `jetbrains-mono-v18-latin-600.woff2`, `jetbrains-mono-v18-latin-700.woff2`.
- [ ] AC-03: Each file's `file --mime-type` reports `application/font-woff2` or `font/woff2`. Verify: `file plugins/autonomous-dev-portal/server/static/fonts/*.woff2 | grep -c woff2` returns `8`.
- [ ] AC-04: Total directory size is between 200 KB and 600 KB (sanity bound; expected ~400 KB per TDD-034 §5.4).
- [ ] AC-05: A `LICENSE.txt` exists at `plugins/autonomous-dev-portal/server/static/fonts/LICENSE.txt` containing the SIL Open Font License (OFL) text for both Inter and JetBrains Mono with attribution.
- [ ] AC-06: Each filename in `design-tokens.css` `src: url('/static/fonts/<name>.woff2')` declarations corresponds 1:1 to a file in `server/static/fonts/`. Verify: every URL listed in the eight `@font-face` blocks resolves to an existing file.

## Implementation

### Files to create / modify
- `plugins/autonomous-dev-portal/server/static/fonts/inter-v18-latin-400.woff2` — NEW.
- `plugins/autonomous-dev-portal/server/static/fonts/inter-v18-latin-500.woff2` — NEW.
- `plugins/autonomous-dev-portal/server/static/fonts/inter-v18-latin-600.woff2` — NEW.
- `plugins/autonomous-dev-portal/server/static/fonts/inter-v18-latin-700.woff2` — NEW.
- `plugins/autonomous-dev-portal/server/static/fonts/jetbrains-mono-v18-latin-400.woff2` — NEW.
- `plugins/autonomous-dev-portal/server/static/fonts/jetbrains-mono-v18-latin-500.woff2` — NEW.
- `plugins/autonomous-dev-portal/server/static/fonts/jetbrains-mono-v18-latin-600.woff2` — NEW.
- `plugins/autonomous-dev-portal/server/static/fonts/jetbrains-mono-v18-latin-700.woff2` — NEW.
- `plugins/autonomous-dev-portal/server/static/fonts/LICENSE.txt` — NEW. OFL text for both families.

### Step-by-step

1. Use [google-webfonts-helper](https://gwfh.mranftl.com/fonts) (or equivalent) to download the Inter family in `latin` subset, weights 400/500/600/700, format WOFF2 only. Rename each file to the `inter-v18-latin-<weight>.woff2` pattern referenced by `design-tokens.css`.
2. Repeat step 1 for JetBrains Mono with the same weights, naming files `jetbrains-mono-v18-latin-<weight>.woff2`.
3. Place all 8 files in `plugins/autonomous-dev-portal/server/static/fonts/`.
4. Download the SIL Open Font License (OFL) text from the upstream Inter and JetBrains Mono GitHub repos. Concatenate into `LICENSE.txt` with section headers identifying which copyright applies to which family.
5. `git add` the 9 files (8 WOFF2 + LICENSE.txt) and verify total checked-in size with `du -sh plugins/autonomous-dev-portal/server/static/fonts/`.
6. Cross-check filenames against `design-tokens.css` `@font-face` `src:` URLs — every URL must resolve.

## Tests

- Unit: none (binary assets).
- Integration: manual browser test — load portal in DevTools, Network tab shows fonts requested from `/static/fonts/*.woff2` (not from `fonts.googleapis.com`); zero CSP violations in console.

## Verification

- `ls plugins/autonomous-dev-portal/server/static/fonts/*.woff2 | wc -l` returns `8`.
- `test -f plugins/autonomous-dev-portal/server/static/fonts/LICENSE.txt && echo OK` returns `OK`.
- `du -sk plugins/autonomous-dev-portal/server/static/fonts/ | awk '{print $1}'` returns a value between 200 and 600.
- For each filename in `grep -oE "/static/fonts/[a-z0-9-]+\.woff2" plugins/autonomous-dev-portal/server/static/design-tokens.css`, the corresponding file exists.
