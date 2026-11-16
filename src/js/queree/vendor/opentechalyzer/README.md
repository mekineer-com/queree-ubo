# OpenTechalyzer Components

`detect/engine.js` and `types.js` are compiled without modification from
[OpenTechalyzer](https://github.com/Houseofmvps/opentechalyzer) commit
`a3d30e479c91c06732ef88867d69b7feef8f3f35`, licensed MIT. The license is in
`LICENSE`.

`../commerce-fingerprints.js` is generated through that upstream project's
WebAppAnalyzer importer. It contains only Ecommerce-category fingerprints and
their required technology dependencies, including entries tagged as both
Ecommerce and CMS. Definitions come from the original WebAppAnalyzer records;
OpenTechalyzer's built-in overrides are not used.

Imported WebAppAnalyzer DOM rules are omitted. OpenTechalyzer's importer
keeps only their selector keys and drops nested attribute/property/text conditions;
that can broaden a specific rule such as `link[href*=...]` into `link`. Native
DOM rules are not added as replacements. WebAppAnalyzer `scripts` patterns are
mapped to `scriptContent`, using the existing collected inline JavaScript;
`scriptSrc` remains limited to script addresses. XHR rules are omitted because
the collector does not distinguish XHR hosts from arbitrary resource hosts.
Other imported rules, including known weak upstream rules, remain unchanged;
these signals identify software, not proof of selling.

Fingerprint sources:

- OpenTechalyzer commit `a3d30e479c91c06732ef88867d69b7feef8f3f35` (MIT)
- WebAppAnalyzer commit `d91f7e510e93457041bea874e8a9ffb011e3e4fe`
  (GPL-3.0)

Regenerate both modules from pinned sources rather than editing them by hand:

```sh
node tools/make-queree-commerce-fingerprints.mjs \
  dist/build/queree-release-sources/opentechalyzer \
  dist/build/queree-release-sources/webappanalyzer \
  src/js/queree/vendor/commerce-fingerprints.js
```

The generator uses the pinned TypeScript importer directly, with Node 24's native
type stripping; it never uses compiled importer leftovers. Cached inputs must
match their pinned revisions and be clean.
`../commerce-signals.js` is a deterministic, ordered, deduplicated projection of
the final fingerprint bundle's JavaScript object paths,
including dependencies. `commerceFingerprintsSHA256` hashes that bundle and thus
identifies both outputs; no separate probe definitions or overrides are used.
