# Team crest source files for Apito Final logo bundle releases.

Flat image files under `logos/` are published as versioned zip bundles on GitHub Releases.

**Latest release:** `v1.0.2` (169 crests). Newer builds include per-file `files[]` and `changelog` in `manifest.json`.

## Maintainer workflow

1. Add or update crest PNG/WebP/SVG files in `logos/` (flat folder only; no subdirectories).
2. Commit and push to `main`.
3. Tag a **semver** release and push the tag:

   ```bash
   git tag v1.0.2
   git push origin main --tags
   ```

4. GitHub Actions builds `dist/manifest.json`, `logos-bundle-<version>.zip`, and a `.sha256` sidecar, then attaches them to the Release.
5. Commit the generated snapshot under `manifests/<version>.json` so the next release can diff added/updated/removed crests.

## Local build

```bash
npm ci
npm run build-bundle -- --version 1.0.0
npm test
```

Outputs land in `dist/` (gitignored). Per-version file lists are written to `manifests/<version>.json` (tracked in git).

## Manifest URL (desktop app)

```text
https://github.com/vunf1/Stream_Futebol_Logos/releases/latest/download/manifest.json
```

## Git storage

Crest binaries are stored as regular git objects (~28 MB total). Git LFS is not used; GitHub Actions checks out the repo and runs `npm ci` without an LFS step.

## Naming

Use basename stems that match club display names (see `futebol-dashboard` `team_logo.rs` token matching). Examples: `sporting-cp.png`, `SL-BENFICA.png`.
