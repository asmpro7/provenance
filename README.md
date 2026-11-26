# Provenance

Provenance is a local plagiarism and citation checker for Zotero. Pick a
paper or draft file and it compares the text with the PDFs in your library.
It finds copied and lightly reworded passages and says whether each one has
a citation. It can also fetch a paper's reference list into a collection so
you can check against what it cites. Checking runs fully on your computer.
Reports are a single file you can filter, save as PDF or export as CSV.

## Install

Download the latest `provenance-<version>.xpi` from
[Releases](https://github.com/asmpro7/provenance/releases), then in Zotero:
Tools -> Add-ons -> gear icon -> Install Add-on From File.

Supports Zotero 7.0 through 10.0.*.

## Use

Select a paper in your library, then Tools -> Provenance:

- **Plagiarism Check...** compares the selected paper (or a draft file:
  txt/md/tex/docx) against the PDFs in your library and writes an HTML
  report.
- **Get References Only (online)** fetches the selected paper's reference
  list into a collection via Semantic Scholar.
- **Get References and Check (online)** does both in one run.
- **Check Whole Collection...** checks every paper in a collection.

Thresholds, exclusions, the fingerprint index, and near-match and
paraphrase detection are adjustable under Edit -> Settings -> Provenance.

Everything is computed locally; no text leaves your computer. The only
online feature is reference fetching (Semantic Scholar), and it is labelled
"(online)".

## Author

[Ahmed Abdelmageed](https://orcid.org/0009-0002-7902-690X)
