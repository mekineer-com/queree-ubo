# Building Quer.ee for Firefox

Quer.ee is a Firefox MV2 fork of uBlock Origin. The release source archive
contains every input needed for the Firefox XPI, including pinned uAssets under
`dist/build/uAssets/`. No Git checkout or moving download is required.

## Requirements

- Linux/POSIX environment
- Bash 5+
- Python 3.12+
- Info-ZIP 3.0+
- Node 24+
- `flock`

Keep the published source ZIP and `SHA256SUMS` beside its extracted directory,
without renaming that directory. Gitless dependency checks verify the ZIP's
checksum and compare its contents with the extracted dependencies. The build
regenerates and checks generated outputs before packaging.

Build the unsigned Firefox package from the archive root:

```sh
bash tools/make-firefox.sh all
```

The result is `dist/build/uBlock0.firefox.xpi`. ZIP timestamps are not normalized,
so compare unpacked file contents rather than expecting identical XPI hashes.
Mozilla signing adds signature files and also changes the distributed archive.

The Firefox metadata step applies the fork's identity and support wording in
every locale. Name-only changes preserve translated text; upstream credits,
documentation and filter-list names remain upstream references.

Quer.ee's selected website-list sources and their license/provenance are kept
under `assets/queree/website-lists/`. Regenerate their data with
`node tools/make-queree-website-lists.mjs`, then rebuild the shared hostname
index with `node tools/make-queree-domain-index.mjs`. This preserves the selected
upstream scopes, not the full Super SEO aggregate. URL-pattern matching uses the
unchanged vendored uBlacklist library.
The Affiliate marketing English/French/Multi domain files supply Advertising
signals and site-wide index exclusions. Their pinned files, hashes and snapshot date are
in the same manifest. Soteria's complete `affiliate.txt` is separately pinned
there with its own README/terms. Its 136 domains check visible outgoing links,
not publisher identity; it uses the same URL matcher, not the hostname taxonomy.
Dropship's complete Redirects & Affiliates file adds 23 `||domain^` rules to the
same link check, under its own CC BY-SA 4.0 terms. The importer accepts only this
anchored-domain form; paths/modifiers fail visibly rather than lose conditions.
No domain-index rebuild is needed when only these link files change.

## Tracking Rule Checks

The offline suite uses synthetic data. To check native rule matching against
a [fresh TrackerDB download](https://github.com/ghostery/trackerdb/releases/latest/download/trackerdb.json)
kept outside the source tree:

```sh
node test/queree/tracking-profile.mjs /path/to/trackerdb.json
```

This checks selected request matches and analytics/widget controls, not broad-web
effectiveness. The downloaded dataset is not bundled in release artifacts.

## Isolated Firefox Checks

`test/queree/run-firefox.mjs` accepts `QUEREE_TEST_XPI` to choose the package.
Before starting Firefox, it checks the complete manifest, copied JavaScript,
libraries, CSS, HTML, domain index and bundled filter assets against this source
tree; rebuild if stale.
It accepts `QUEREE_TEST_STARTUP_SETTINGS` as a JSON object of stored settings
applied before startup in its disposable copy. `--startup-only` checks startup
and observes it for a minute.
`--single-domain-only` checks observed resource boundaries, provisional hiding,
contribution metadata and checkbox restoration on disposable local pages.
`--pagination-stay-only` checks that a result returning HTTP 204 leaves the
search document alive and its unfinished pagination able to continue.
`--explanations-only` checks fresh and cached exclusion labels, result replacement
and label placement. `--shopping-only` checks software-only and product-offer-only
signals, ordinary reference links, an ordinary page, independent sponsored
links and advertising, setting changes without
reinspection, cache reuse, contribution metadata and container cleanup.
`--malware-only` loads the full badware/URLhaus profile with the ordinary lists
deselected, then checks isolated malware matches and harmless controls on local
test pages. It does not visit real malware addresses.
The full suite also checks recovery after a temporary 403.
On RAM-capped hosts, URLhaus cold compilation can dominate the startup peak.
Omit it only from the test profile's `selectedFilterLists` when testing unrelated
features; retain `adguard-generic` for Quer.ee eligibility checks. These overrides
do not change the built XPI or the user's profile.

## Versioning and Updates

Quer.ee uses its own numeric release versions, beginning with `2.0.0`. The
exact uBlock Origin base is recorded separately in `SOURCE-MANIFEST.txt`; do not
reuse uBO's release number as Quer.ee's version.

Public builds use Mozilla's update service, not a self-hosted update manifest.
`gecko_android` declares Android store availability from Firefox 142, which
supports the data-consent declaration; desktop Firefox remains supported from 140.
Private builds through 2.2.58 used `https://quer.ee/extension/updates.json`; their
first Mozilla-hosted signed installation is manual. Keep matching source for
every published XPI, including any identical signed copy offered on quer.ee.

Release preparation compares against the latest completed `queree-v<version>`
tag. The private-release script creates the next tag only after verification.
Bump `decisionPolicyRevision` when saved decisions become incompatible. The gate
lists changed policy files for review; routine ad snapshot refreshes need no bump.

Private release preparation additionally needs Git and npm. Set
`QUEREE_SERVER_TAXONOMY_MANIFEST` to the matching server taxonomy's JSON sidecar
and `QUEREE_SERVER_TAXONOMY_DATABASE` to
its SQLite database. The gate verifies their hash, metadata and logical content,
and rejects changed classification inputs since the recorded `source_commit`.
Coordinate a new export separately when this check fails. The release rebuilds
the website lists, domain index and commerce pair from archived pinned sources
and compares every output before testing or packaging. Check these locally with
`node tools/check-queree-generated.mjs`; it writes only disposable outputs.
Cached dependencies must match the lock and have no tracked, untracked or ignored
changes. Source archives use their included `SOURCE-MANIFEST.txt` and checksummed
source ZIP instead of Git metadata.

## Commerce Fingerprint Provenance

The tracked `commerce-fingerprints.js` is already source input to the ordinary
XPI build. Its preferred upstream TypeScript and JSON sources are included under
`third_party_sources/` so the generated file can also be modified or verified.

```sh
node tools/make-queree-commerce-fingerprints.mjs \
  third_party_sources/opentechalyzer \
  third_party_sources/webappanalyzer \
  /tmp/commerce-fingerprints.js
cmp /tmp/commerce-fingerprints.js \
  src/js/queree/vendor/commerce-fingerprints.js
```

Regeneration uses Node 24 to read the upstream TypeScript directly; no dependency
installation or OpenTechalyzer build is needed.
The generated module exports both upstream source identifiers for runtime
provenance; refreshing the lock and generated pair needs no controller pin edit.

## Domain Index

UT1 Shopping/Bank/Press and Dropship retailer inputs are retained unmodified in
`tools/vendor/website-domains/`, with pinned upstream revisions, paths, byte sizes
and hashes in `provenance.json`. These build-only inputs are included in the
source archive, not the XPI. They reproduce today's list membership and ordering;
shared-host and public-suffix boundaries remain the existing index builders' job.

Verify the raw inputs and reproduce the committed modules without writing:

```sh
node tools/make-queree-website-domains.mjs
```

For an update, replace the selected raw files with unmodified upstream bytes and
update their manifest revisions/URLs, sizes and hashes. Then generate into a
scratch directory first:

```sh
node tools/make-queree-website-domains.mjs tools/vendor/website-domains/provenance.json /tmp/queree-domain-update
```

Review that diff before copying the two modules into `src/js/queree/vendor/`.
The generator preserves other sources, including DOAJ. Rebuild the index and
coordinate the server taxonomy as for any classification-data update; never
replace a raw file's hash merely to silence a failed verification.

The tracked domain-list modules are corresponding source for the compact
hostname index. Rebuild the binary and metadata after changing those modules or
their generators:

```sh
node tools/make-queree-domain-index.mjs
```

The unused referral-list snapshot, importer and importer test are retained under
`research/referral-lists/`, outside the extension's runtime and package.

The build is deterministic. `THIRD_PARTY_NOTICES.txt` records each dataset's
source, license, attribution, and the transformations Quer.ee applies.

Both index builders reapply the shared-host guard to public-interest declaration
snapshots, including older inputs. Their metadata records `shared_host_excluded`;
the original source snapshots and hashes remain intact. Company ownership claims
are kept separately and retain the existing exact-host boundaries.

### Reviewed Non-root Cases

Conflicting company non-root/homepage declarations require
individual review. Record each chosen category, organisation, evidence and reason
in `tools/vendor/reviewed-domains/reviewed.tsv`. A homepage address or Wikidata type
is evidence to inspect, not an instruction to assign that category to the domain.

Tools may collect candidates and source facts. They must not fill categories,
choose a homepage winner or promote RDF type hints into reviewed decisions.
Review new or changed cases before editing the table; do not bulk-copy inferred
categories and call the result reviewed. Uncertain cases may explicitly remain
unclassified. Keep the original declarations as evidence.

The build must read the reviewed TSV directly. Do not introduce a category
generator, generated JS copy of the table, or regeneration/comparison of that
copy. Only the existing compact index and server taxonomy need generation:

```sh
node tools/make-queree-domain-index.mjs
```

Rebuild the matching server taxonomy from the corrected clean source commit
before rollout. The review table is build-only; browser/server matching remains the existing hostname
lookup, with no ownership inference subsystem or runtime path matching.

### Other Ownership Inputs

Organization importers use the pinned Maigret data in `tools/vendor/maigret/` to
omit account/profile addresses without treating their entire host as a platform.
This is offline tooling, not browser code or an account scanner. New imports
record the snapshot hash and the number of omitted profile addresses. Updates
replace that snapshot, retain its MIT notice, and rerun the source tests before
regenerating affected lists. Disabled entries and subdomain templates are skipped;
subdomain boundaries continue to use the existing public-suffix handling.
Corporate (including `--yc`), Wikidata public-interest and ACNC imports take
`INPUT YYYY-MM-DD [OUTPUT]`. Supply the original retrieval day, not today's date
when rerunning the same snapshot. The Charity Commission importer reads only
`publicextract.charity.json` from its ZIP; other members are not records.

The November 16 broad Wikidata import uses the archived exports, not the research
cache. `tools/vendor/wikidata-broad-queries/` retains the exact queries and
uncompressed input hashes. The 11 JSON exports and the root-homepage TSV remain
build inputs only; neither is included in the extension. On the research host:

```sh
archive="$HOME/.local/share/queree-research/wikidata-categories-20261116"
work=$(mktemp -d)
tar -xzf "$archive/inputs.tar.gz" -C "$work"
gzip -cd "$archive/public-companies.json.gz" > "$work/public-companies.json"
gzip -cd "$archive/all-homepages.tsv.gz" > "$work/all-homepages.tsv"
node --max-old-space-size=600 tools/make-queree-wikidata-broad-domains.mjs "$work" "$work/all-homepages.tsv"
node tools/make-queree-domain-index.mjs
rm -r "$work"
```

The importer checks each original input against the pinned hashes before writing
the derived sources. Company records with a positive government type path are
not assigned from that flag alone; direct government and public-university
records remain usable. Positive nonprofit and education facts are retained.
Journal URLs are evidence only, not publisher ownership. Unreviewed company
non-root/homepage overlaps and conflicting ownership claims are omitted from
the new sources; the original supplier snapshots and prior sources are unchanged.

DOAJ journal hosts are imported from its public CC0 journal CSV. Pass the
snapshot's date explicitly; the source hash, date and selected DOAJ records are
retained in the generated module. Root homepage URLs are used without expanding
journal paths into whole-host claims or applying a publisher-size cutoff:

```sh
node tools/make-queree-doaj-domains.mjs /path/to/doaj.csv YYYY-MM-DD
node tools/make-queree-domain-index.mjs
```

The IRS charity source merges the official 990-N ZIP with NCCS's prepared
990/990-EZ header tables. Keep the four current BMF files (`eo1.csv` through
`eo4.csv`) and all three recent `nccs-header-YYYY.csv` tables in one input
directory. For a 2026 snapshot, the required years are 2023, 2024 and 2025.
Download `F9-P00-T00-HEADER-YYYY.CSV` from the
[NCCS e-file v3.1 catalog](https://urbaninstitute.github.io/nccs/catalogs/catalog-efile-v3_1.html)
and save each as `nccs-header-YYYY.csv`:

```sh
node tools/make-queree-irs-domains.mjs /path/to/990n.zip /path/to/inputs 2026 YYYY-MM-DD
node tools/make-queree-domain-index.mjs
```

The year argument is the snapshot year, not the minimum tax year. Missing
annual tables fail rather than silently reverting to older declarations.
Keep matching `eoN.headers` and `nccs-header-YYYY.headers` from
`curl --dump-header` to record source dates; input hashes are always recorded.
CSV hashes cover the exact bytes consumed by the parser. IRS also records the
uncompressed postcard member's `content_sha256`, separately from its ZIP hash.
Both ZIP importers parse and hash a disposable disk snapshot, so replacing or
overwriting the original ZIP during import cannot misattribute its provenance.
The latest tax period wins, then the UTC filing timestamp. A newer blank or
final return does not revive an older website. Other charity sources are
preserved. The importer requires Python's standard library,
not a browser or an additional runtime matcher. Regenerate the server taxonomy
from the committed extension source afterward, following the server README.

`tools/queree-irs-website-errata.json` records dated corrections to exact
EIN/period/filing-time/reported-website declarations, applied only after the
latest declaration is selected. Generated `website_errata` metadata retains the
errata file hash and applied entries, separately from unchanged raw-input hashes
and the original retrieval day. These are source corrections, not runtime host
exceptions. The Altru correction preserves the independent `altru.org` claim.

## Licensing

The extension is GPLv3; see `LICENSE.txt`. Dataset and derived-code attribution
is in `THIRD_PARTY_NOTICES.txt`. Third-party source snapshots retain their own
license and notice files. Do not distribute an XPI without providing equivalent
access to the exact corresponding source archive.

The release source also includes `QUEREE_PRIVACY.md`, which describes the
optional data transmission that must be declared during Mozilla submission.
