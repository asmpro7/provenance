# Releasing Provenance

How to cut a release and ship it on GitHub so installed copies of the
plugin can update themselves.

## One-time setup (done for github.com/asmpro7/provenance)

The repository is `github.com/asmpro7/provenance`. The wiring assumes the
default branch is `main` and release tags are named `v<version>` (for
example `v1.0.0`):

- `manifest.json`:
  - `homepage_url` = `https://github.com/asmpro7/provenance`
  - `applications.zotero.update_url` =
    `https://raw.githubusercontent.com/asmpro7/provenance/main/updates.json`
- `updates.json`: the latest entry's `update_link` =
  `https://github.com/asmpro7/provenance/releases/download/v<version>/provenance-<version>.xpi`

IMPORTANT: the release asset must be named exactly
`provenance-<version>.xpi` (for example `provenance-1.0.0.xpi`) - the
update link 404s on any other filename.

## Each release

1. Bump the version in `manifest.json` and in the header comment of
   `main.js` (keep them identical).
2. Verify everything is green:
   ```
   node tests/run-all.js
   node benchmark/run.js
   ```
   If the benchmark numbers changed, update the Accuracy section of the
   README with the new measured values.
3. Add a CHANGELOG entry.
4. Build the plugin:
   ```
   python3 build.py          # writes provenance-<version>.xpi
   ```
5. Commit and tag: `git tag v<version> && git push --tags` (v-prefixed tag names, e.g. `v1.0.0` - the asset URL pattern depends on it).
6. Create a GitHub release from the tag and attach
   `provenance-<version>.xpi` (built .xpi files are git-ignored on
   purpose - releases carry them, the repo does not).
7. Update `updates.json`: set the top entry's `version` and point
   `update_link` at the release asset
   (`https://github.com/asmpro7/provenance/releases/download/v<version>/provenance-<version>.xpi`),
   commit and push to `main`. Installed copies read updates.json from the
   raw URL on `main` and pick the update up from there.
8. Zip the source for the release:
   ```
   git archive --format=zip -o provenance-source-<version>.zip HEAD
   ```
   and attach it to the release as well.
