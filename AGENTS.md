# Kotonohatlas repository instructions

The root `AGENTS.md` applies here. The following Kotonohatlas-specific test rules are mandatory.

## Never pin mutable map content

- Do not hard-code current country, city, Admin-1, language, translation, exonym, endonym, transliteration, or review-consensus text in a test expectation.
- Do not hard-code current feature totals, locale totals, coverage totals, catalog order, generated hashes, or upstream dataset output.
- Curated map data is deliberately reviewable. A valid review or consensus change must not make a test fail merely because the selected label changed or moved between `locales.*` and `scripts.*` under sparse storage.
- Do not “fix” such a failure by changing the expected string to the new current string. Delete the assertion or test a stable property instead.
- For live Kotonohatlas data, test schema, ISO/reference integrity, normalization, allowed script shape, sparse-storage invariants, and resolution/fallback behavior through production resolution functions.
- For exact label-merge, voting, import, and fallback behavior, construct a minimal synthetic catalog in a fresh test fixture. Production curated rows are not golden fixtures.
- Exact real-world values are allowed only as explicitly documented immutable regression sentinels. The test comment must identify the contract being protected and why ordinary curation cannot change it.

Reviewers must reject tests whose only purpose is to preserve today's map wording or storage placement.
