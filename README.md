# belmont-weather-pipeline

The Belmont News weather roundup pipeline. Pulls the NWS source of record and
MET Norway as the second independent source, aligns their forecast windows, and
emits a comparison the desk gate can check.

Plain Node ES modules. **Zero dependencies. No build step, no bundle, no
compile.** No credential of any kind: MET Norway needs none, and neither does
this tool.

## Why it lives in its own repository

It is a tool, not content and not site code.

- `belmont-news/blogs` is editorial content, no build and no deploy (BEL-18
  §2, rule 4). A network-fetching executable does not belong in a store that
  writers edit.
- `belmont-news-site` is the production publish path. Its Netlify build command
  is `npm test && npm run build`, and every push to `main` is a production
  deploy. A tool that calls two live weather APIs has no business on that path.

A separate repository gives the M2 routine one small, stable clone target with
no `npm install` and no gate to satisfy.

## Requirements

Node **20 or newer**. Nothing else.

## Run it

```bash
node bin/weather-roundup.mjs --edition morning --out artifact.json --pretty
node bin/weather-roundup.mjs --edition evening
node --test "test/*.test.mjs"
node test/run-failure-path-demo.mjs http-503
```

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | The roundup ran, on both sources or on one with the reason printed, and the source of record was stable across its pulls. |
| `2` | The source of record did not answer, so the roundup did not run. |
| `3` | A blocker was raised but the roundup still ran. Either the second source is missing, or the source of record served two different products under one stamp. |

## Product identity

BEL-17 section 2 makes this API the source of record and requires an item to
cite the `generatedAt` of the pull actually used. On 2026-10-03 that endpoint
served three different `generatedAt` values and two different forecast bodies
under one identical `Last-Modified` and one identical `ETag`, so a citation of
that stamp cannot be reproduced by re-pulling the URL. The evidence is in
`docs/bel-91-stamp-does-not-identify-product.md`.

So every run does more than pull the source of record once:

- It records the response headers that decide which product a pull was served.
  An absent header is recorded as `null`, never inferred.
- It fingerprints each pull over exactly the fields an item publishes, per period
  and for the product as a whole.
- It makes a **confirmation pull** of the same endpoint and compares. Two pulls
  sharing a `Last-Modified` or an `ETag` but not a fingerprint is a collision, and
  `generatedAt` moving backwards between pulls is a regression. Both are reported.
- The artifact carries `sourceIntegrity` (what was compared, and what was found)
  and `sourceCitation` (`generatedAt`, `Last-Modified`, product fingerprint, and
  the hash of the period the item publishes).

A finding does not stop the roundup. The item publishes the product it actually
pulled, records its fingerprint, prints the finding and escalates, which is what
BEL-17 requires of an item whose source is internally inconsistent. The run exits
`3`. Failing instead would leave a gap where the desk has nothing to check.

## Sources

| Source | Role | Credential |
| --- | --- | --- |
| National Weather Service (`api.weather.gov`) | Source of record, first | none |
| MET Norway (`api.met.no`) | Second independent source | none |

Both are reached with an identifying `User-Agent`, as each provider requires.
MET Norway answers `203` for a deprecated API version and `503` under load;
neither is read as data, and both are recorded as blockers instead.

## Provenance

Source as committed locally at `45e8856` on BEL-79, by Thandiwe Okonjo. Placed
here for the M2 routine on BEL-89. Which source is named is decided on BEL-75.

One repair was made in transit, on BEL-89: the BEL-79 source document had its
`\n` escape sequences rendered as real newlines, which made
`bin/weather-roundup.mjs` a syntax error. The BEL-79 test suite passed 23/23
regardless, because it exercises `src/` and never imports `bin/`. The escapes
were restored here, and `.github/workflows/test.yml` now runs a `--help` smoke
of the CLI so that exact gap cannot recur unnoticed.