# Provenance architecture and developer guide

This guide is for contributors. It explains how the repository is laid out,
what every part of `main.js` does, how a plagiarism check flows end to end,
how settings and localization work, and how to add a feature, a language,
run the tests, and cut a release.

User-facing documentation lives in [README.md](../README.md); version
history lives in [CHANGELOG.md](../CHANGELOG.md).

## Repository layout

```
manifest.json        plugin manifest (Zotero 7-10, manifest v2)
bootstrap.js         Zotero lifecycle glue (startup/shutdown, window hooks)
main.js              the whole plugin: menus, engine, report, i18n
prefs.js             default preference values (loaded by Zotero at startup)
preferences.xhtml    settings pane markup
preferences.js       settings pane logic (bindings, presets)
build.py             builds provenance-<version>.xpi (a plain zip)
tests/               Node unit tests + run-all.js runner
icons/               plugin icon (SVG source + 16/32/48/96 PNG)
docs/ARCHITECTURE.md this file
```

There is no build toolchain beyond `build.py` and no runtime dependencies:
the plugin is plain JavaScript loaded by Zotero's bootstrap mechanism.

## Startup sequence

1. Zotero loads `bootstrap.js` and calls `startup()`.
2. `startup()` registers the settings pane
   (`Zotero.PreferencePanes.register`, pointing at `preferences.xhtml` +
   `preferences.js`), loads `main.js` into the bootstrap scope, calls
   `Provenance.init(...)` and `Provenance.addToAllWindows()`.
3. `addToWindow(window)` injects the menu items (Tools menu and the
   item/PDF context menus). Every injected element id is recorded via
   `storeAddedElement` so `removeFromWindow` can cleanly remove it on
   shutdown.

`main.js` is a single `Provenance` object literal. Everything below is a
method or property on it.

## Function map (main.js)

Grouped by role, in roughly the order a check touches them. Line numbers
drift; search for the name.

### Infrastructure

- `init`, `log`, `console` - setup and tracing. `console` writes both to
  the Zotero Error Console and to a timestamped in-memory buffer
  (`_logLines`, capped at 800 lines) that `saveLog` persists.
- `error`, `stage` - error handling. `stage(name)` records the current
  pipeline stage so every surfaced error names where it happened.
- `saveLog(reportPath)` - writes `<report>.log.txt` next to a report.
- `cfg()` - returns the effective settings (defaults overlaid with
  `Zotero.Prefs`), memoized in `_cfg`.
- `truncate`, `escapeHTML`, `normTitle`, `collPath` - small helpers.

### Progress panel

- `openProgress`, `_progressAdd`, `_progressBar`, `_progressFinish` - the
  live loading panel: stage lines, a progress bar, and a Cancel button.
  `prog.cancelled` is polled by the long loops.

### Entry points (menu actions)

- `runCheckOnly` - check one paper against a chosen collection or library.
- `runFetchOnly` - fetch references from Semantic Scholar without checking.
- `runSweep` - fetch references, then check.
- `runBatchCheck` - cross-check every paper in a collection against every
  other; writes one summary page via `buildBatchHTML`.
- `runAbout` - About & Self-Test dialog; calls `selfTestEngine`.

### Paper and collection plumbing

- `getSelectedPaper`, `selectPaperOrAlert` - resolve the selected item,
  including a selected standalone PDF attachment.
- `pickCollection`, `collectionDepth`, `collectionItemsDeep` - collection
  picker and deep (subcollection-inclusive) item listing.
- `fetchReferences`, `httpJSON`, `importReferences` - the Semantic Scholar
  reference fetcher (the only network feature; never used by checking).
- `mapPool` - small promise pool for bounded parallelism with per-item
  error capture.

### Analysis and history helpers (pure, unit-tested)

- `splitSections` / `sectionScores` - heading detection and per-section
  matched share.
- `buildVerdict` - plain-language verdict sentences for the report top.
- `historyDelta`, `loadHistory`, `saveHistory`, `recordHistory` - the
  before/after check comparison.
- `getSourcePages`, `findPageForSnippet`, `normPageText` - source PDF page
  lookup for matched passages.

## The check pipeline, end to end

`runCheckOnly` orchestrates this; the heavy lifting is `performCheck`.

1. **Text read** - `getItemFullText(item)` gets the best PDF attachment,
   ensures it is indexed (`Zotero.Fulltext.indexItems(..., {complete:true})`)
   and reads its text via `attachment.attachmentText` (the supported path;
   Zotero 10 removed `Fulltext.getItemContent`). Failures log and return
   `''`.
2. **Cleanup** - `prepareText(text)` normalizes PDF extraction artifacts:
   soft hyphens, no-break spaces, ligatures, smart quotes/dashes, and words
   split by line-break hyphenation. It also normalizes Arabic: tatweel and
   harakat (diacritics) are removed and alef variants and alef maksura are
   unified, so copies that differ only in vocalization or presentation
   still match. With `excludeBibliography` it cuts the bibliography, first
   by a References-style heading (numbered or not), then by detecting a
   numbered reference tail in the last part of the document.
3. **Tokenizing** - `tokenizeDetailed(text)` produces lowercased word lists
   with character offsets. `gramHashArray`/`gramsOf` turn word n-grams
   (default 8) into FNV-1a hashes (`hashGram`).
4. **Source fingerprints and the cache** - `getSourceFingerprint(ref, cfg,
   needText)` builds `{hashes, cwHashes, rto, basis}` per source, storing
   hashes in the persistent index (`loadIndex`/`saveIndex`,
   `provenance-index.json` in the data directory, serialized by
   `hashesToString`/`stringToHashes`). A cached entry is reused only when
   the modification date and n-gram size match; an entry that is
   suspiciously short (`len < 200`) for a source that has a PDF is treated
   as stale and re-extracted. A source whose attachment yields no text is
   marked `unreadable` so the report can name it honestly.
5. **Inverted matching** - `buildPostings` builds a phrase-hash to sources
   index over all fingerprints, so one pass finds every source sharing a
   gram with the paper. This is what makes whole-library checks scale.
6. **Verbatim match** - `matchSource` / `buildMatch` collect matched gram
   positions, merge them into readable passages (`mergePassages`), expand
   them to full sentences, and compute `paperPct` (share of the paper the
   source covers) and `reusePct` (share of the source reused). Common
   phrases (grams shared by at least `COMMON_DF_MIN` sources) are removed
   from both the overall score and each source's coverage before flagging,
   and reported separately as `commonPct`.
7. **Citation detection** - for each passage, `findCitation` scans the text
   just after it for numbered ([12], [3,4], [3-7]), parenthetical, and
   narrative citations; `citeStatus` classifies it as `cited`,
   `nearby` (a citation close but not attributable), or `none`, matched
   against the source's year and authors.
8. **Near-match** - alongside verbatim grams, each fingerprint carries
   `cwHashes`: grams over stemmed content words (`contentStems`,
   `lightStem`, `NEAR_NGRAM`). The overlap ratio `cwHit / cwCount` is the
   per-source near-match score. It catches lightly reworded copying and
   never counts toward the overall score.
9. **Paraphrase** - `paraphraseLocal` splits the paper and matched sources
   into sentence-ish units (`splitUnits`) and flags paper sentences whose
   content-word stems are heavily contained in a source sentence. Fully
   local; no text leaves the machine.
10. **Section scores** - `splitSections` finds heading lines (Abstract,
    Introduction, Methods, ...) and maps them to word ranges; it returns
    [] when fewer than two headings exist so the report simply skips the
    section table. `sectionScores` computes each section's matched share
    from the union of matched gram indices.
11. **Source page numbers** - for up to `PAGE_SOURCES_MAX` matched sources,
    `getSourcePages` reads per-page text via `Zotero.PDFWorker.getFullText`
    (null when unavailable, so older Zotero and non-PDF sources degrade
    silently) and `findPageForSnippet` maps each displayed source passage
    to its 1-based page, shown as a "source page N" chip in the
    side-by-side view.
12. **History** - `recordHistory` appends the result to
    `provenance-history.json` (`loadHistory`/`saveHistory`, capped at
    `HISTORY_MAX_PER_ITEM` entries per paper) and returns the previous
    entry; `historyDelta` turns the pair into the before/after comparison
    box at the top of the report.
13. **Report** - `deliverReport` writes the HTML (built by
    `buildReportHTML`, with `scoreClass` and `citeChip` for styling), saves
    the run log next to it (`saveLog`), opens the report, and attaches a
    summary note to the item (`attachSummaryNote`). The report leads with
    `buildVerdict` (plain-language sentences about the score, flagged and
    reworded sources, uncited passages and common phrasing) and the
    before/after comparison box, then the flagged/watch lists
    (`isFlag`/`isWatch` thresholds), the highlighted full text,
    side-by-side passage pairs, the section table, the unreadable /
    no-text source list, duplicates, a CSV download, a sort control, and a
    Save as PDF button with a print stylesheet.

The batch mode repeats steps 1-10 per paper in a collection and renders a
summary page with `buildBatchHTML`.

### Self-test

`selfTestEngine(cfg)` runs the real matcher on two synthetic in-memory
texts and returns PASS/FAIL per path (verbatim, near-match, paraphrase,
artifact cleanup). `runAbout` renders it; `tests/test-74.js` asserts it.
If you change the engine, the self-test and that test file are your first
signal.

## Settings

- `prefs.js` registers the defaults with Zotero at install/startup.
- `main.js` `DEFAULTS` mirrors them; `cfg()` reads
  `extensions.provenance.<name>` and falls back to the default when the
  pref is missing.
- `preferences.xhtml` is static markup; `preferences.js` drives it:
  - `BINDS` maps each control id to `[elementId, prefName, type]`.
  - On load, each control is filled from the pref, falling back to
    `DEFAULTS` so a field never renders empty.
  - Changes write through with `Zotero.Prefs.set(..., true)`.
  - `PRESETS` holds Strict / Normal / Lenient; `applyAll(values)` writes
    all prefs and updates the visible inputs in one pass. Reset applies
    `DEFAULTS`.

To add a setting: add it to `DEFAULTS` (main.js), `prefs.js`, the markup,
`BINDS`, and each entry of `PRESETS` that should differ, then cover it in a
test.

## Localization

UI strings live in `STR.en` and `STR.ar` at the top of `main.js`. `t(key)`
resolves a key for the current locale (`_lang()` reads
`Services.locale.appLocaleAsBCP47`, with `P._testLang` as a test override)
and falls back to English. Menus and the progress panel are localized;
reports stay English.

To add a language: add a `STR.<code>` object translating every key in
`STR.en`, keep the `Provenance` prefix in menu labels, and extend
`tests/test-73.js` (it asserts every English key exists in Arabic - mirror
that for the new language).

## Adding a feature

1. Read the pipeline section and pick the stage your feature belongs to.
2. Add the logic as a focused method on `Provenance`; keep matching code
   pure (no Zotero calls) so the Node tests can reach it.
3. Wire any user-visible setting through the settings steps above.
4. Add or extend a `tests/test-*.js` suite; pure functions are tested by
   compiling `main.js` in Node (see the harness at the top of any suite).
5. Update README (user-facing), CHANGELOG, and this file if the pipeline
   or structure changed.

## Testing

From the repo root:

```
node tests/run-all.js
```

Each suite rewrites the `Provenance = ` export line to `module.exports = `,
compiles `main.js` with `module._compile`, calls
`P.init({id, version, rootURI})`, and exercises the pure engine. Zotero
objects are stubbed per test where needed. Suites are named after the
version that introduced their features (`test-65.js` ... `test-86.js`),
plus `test-engine.js` and `test-mappool.js`.

`test-83.js` mocks `Zotero.HTTP.request` and covers the 8.3 fetching
hardening: slow requests hit our own timeout, 429/5xx/network failures
retry with backoff, cancellation aborts mid-request and mid-backoff, and
failures map to friendly messages.

`benchmark/run.js` is the accuracy smoke test: a small labeled corpus
(`benchmark/corpus/`, papers that should and should not flag) scored
through the real matcher, printing hit rate and false-alarm rate. The
measured numbers are quoted in the README - update them together.
Robustness coverage (8.1) includes broken/deleted items in scope,
cancelled runs, unreadable attachments, and a 2000-source scale check.

## Release

1. Bump `version` in `manifest.json` and the header comment in `main.js`.
2. `node tests/run-all.js` must be green.
3. `python3 build.py` writes `provenance-<version>.xpi`.
4. Add a CHANGELOG entry. Built .xpi files are git-ignored; attach them to
   the release rather than committing them.
5. Zip the repo (excluding `.git/` and built xpis) as the source archive.
