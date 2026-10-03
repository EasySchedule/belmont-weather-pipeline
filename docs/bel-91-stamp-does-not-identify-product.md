# BEL-91: the stamp does not identify the product

`https://api.weather.gov/gridpoints/PBZ/50,48/forecast` served at least three
different `generatedAt` values and two different forecast bodies under one
identical `Last-Modified` **and** one identical `ETag`. This is the evidence, the
mechanism, and the rule the pipeline now enforces so it cannot happen silently
again.

Collected by Grant Kowalczyk (CTO) from an engineering run, 2026-10-03,
anonymous, no credential, `User-Agent` identifying Belmont News. Confirms and
extends the reproduction already on BEL-91.

## 1. Three generations, one stamp

| Pull | Runner | `generatedAt` | `Last-Modified` | `ETag` | Period 1 PoP | Period 1 `shortForecast` |
| --- | --- | --- | --- | --- | --- | --- |
| 00:44:54Z | reporter, BEL-91 | `2026-10-03T00:19:57+00:00` | `Fri, 02 Oct 2026 22:41:34 GMT` | same throughout | 3 | Mostly Cloudy |
| 00:46:51Z onward | reporter, BEL-91 | `2026-10-02T23:17:15+00:00` | same | same | 17 | Slight Chance Rain Showers then Mostly Cloudy |
| 01:01:38Z-01:13:18Z | this run, 40 polls | `2026-10-02T23:17:15+00:00` | same | same | 17 | Slight Chance Rain Showers then Mostly Cloudy |
| **01:10:00Z** | **this run, `belmont-weather-pipeline`** | **`2026-10-03T00:44:55+00:00`** | **same** | **same** | **3** | **Mostly Cloudy** |

Three distinct `generatedAt` values under one `Last-Modified`. BEL-91 said: "If a
later pull returns a third `generatedAt` under the same stamp, that is the
finding." It does.

The 01:10:00Z pull and the 01:10:20Z pull are **20 seconds apart, same runner, same
URL, same headers**: different body, same stamp.

## 2. The two products, field by field

Product A, `generatedAt 2026-10-03T00:44:55+00:00`, product fingerprint
`f0195b85e93a072f766b982341b949e80f73a3a73b4a12cbedee179e8e9924fa`.

Product B, `generatedAt 2026-10-02T23:17:15+00:00`.

Both carry `Last-Modified: Fri, 02 Oct 2026 22:41:34 GMT` and both carry
`ETag: W/"1790980896:dtagent10337260504112723F6xZ:dtagent10337260504112723F6xZ"`.

Comparing all 14 periods on every field the roundup publishes, **3 fields differ,
all in period 1**:

| Period | Field | Product A | Product B |
| --- | --- | --- | --- |
| 1 Tonight | `probabilityOfPrecipitation.value` | 3 | 17 |
| 1 Tonight | `shortForecast` | `Mostly Cloudy` | `Slight Chance Rain Showers then Mostly Cloudy` |
| 1 Tonight | `startTime` | `2026-10-02T20:00:00-04:00` | `2026-10-02T19:00:00-04:00` |

Periods 2 through 14 are identical field for field. This matches BEL-91 exactly,
on a second runner, half an hour later.

## 3. Why the stamp cannot work

**The `ETag` is derived from `updateTime`, not from the body.**

```
etag epoch component 1790980896 = 2026-10-02T22:41:36+00:00
observed properties.updateTime  = 2026-10-02T22:41:36+00:00
observed Last-Modified          = Fri, 02 Oct 2026 22:41:34 GMT
```

Both the `ETag` and the `Last-Modified` name the same upstream `updateTime`, and
neither varies with the bytes served. They are upstream-timestamp validators, not
body validators, so two different forecast products legitimately carry the same
one. No header on this response identifies the product.

**The origin does not honour that `ETag` as a validator either.** A conditional
`GET` carrying `If-None-Match: W/"1790980896:..."` returns **HTTP 200 with a
full body**, not `304 Not Modified` — confirmed across 12 polls over 10 minutes.
So neither a reader nor a cache can use these headers to detect the swap.

`Cache-Control: no-cache` and `Cache-Control: no-cache, no-store` were tested on
every one of 40 polls and changed nothing: the same product came back each time as
its own variant. `x-server-id` was `vm-cprk-api-ops-app11.ncep.noaa.gov` on every
pull. So this is not explained by one edge node serving a stale object while
another serves a fresh one.

## 4. What this is not

- **Not a wrong number.** Nothing here says which body is correct. Product B is the
  body carrying the internal 17-versus-20 disagreement already logged in
  `corrections/2026-10.md`; its `detailedForecast` still reads "Chance of
  precipitation is 20%" beside a `probabilityOfPrecipitation` of 17. That is
  upstream's inconsistency to reconcile or report, not this desk's.
- **Not a live-transport problem.** Every pull was HTTP 200 with well-formed
  GeoJSON.
- **Not resolved by a later pull.** It is still happening; the 01:10:00Z pull
  demonstrates it.

## 5. The rule the pipeline now enforces

BEL-91 recommends the desk rule: an item citing a `Last-Modified` records the
`generatedAt` **and** a hash of the period it publishes. This is the engineering
half of that, and it does not depend on the endpoint ever being consistent.

- **`src/http.mjs`** captures the response headers that decide which product a
  pull was served. Before this the pipeline recorded a pull's body but not the
  stamp naming it, so the desk was citing a `Last-Modified` value the pipeline had
  never captured. A header that is absent is recorded as `null`, never inferred.
- **`src/provenance.mjs`** fingerprints every pull over exactly the fields an item
  publishes, per period and for the product as a whole. It reports a
  `last_modified_collision`, an `etag_collision`, and a `generated_at_regression`
  when two pulls share a stamp but not a fingerprint, or when `generatedAt` moves
  backwards. An unrelated upstream field the roundup does not publish does not
  read as a different forecast.
- **`src/roundup.mjs`** makes a **confirmation pull** of the source of record and
  runs that check every run. One extra `GET` of a free, credential-free API is
  the cost of the item being checkable. The artifact carries a `sourceIntegrity`
  block and a `sourceCitation` block with the `generatedAt`, the `Last-Modified`,
  the product fingerprint, and a hash of the published period.
- **A finding does not stop the roundup.** The item publishes the product it
  actually pulled, records its fingerprint, prints the finding and escalates,
  which is what BEL-17 requires of an item whose source is internally
  inconsistent. It exits 3 with a non-fatal blocker. Failing the run instead
  would leave a gap where the desk has nothing to check.
- **`test/stub.mjs`** reproduces the endpoint exactly: two bodies, one
  `Last-Modified`, one `ETag`, `generatedAt` moving backwards, and the order
  BEL-91 recorded. Exercised over real HTTP against the real pipeline.
- **`test/provenance.test.mjs`** covers the fingerprint, the collision, the
  regression, a stable repeat pull, a source that answers with no stamp at all,
  and both outcomes of a live run.

Suite: 33 tests, 33 pass. `node --check` clean across `bin`, `src` and `test`. CLI
`--help` smoke passes.

## 6. What still needs a human

Reporting this to NWS is a human escalation to an outside organisation, and this
run has no such mandate. The reproduction above is the input it needs: two
products, one `Last-Modified`, one `ETag`, on two runners, reproducible 20 seconds
apart, with the `ETag` epoch component resolving to `updateTime`.

## 7. Reproducing this

`probe.py` in this directory pulls the endpoint in four variants per round —
plain, `no-cache`, `no-store`, and conditional `If-None-Match` against the
previous `ETag` — and records `generatedAt`, `updateTime`, `Last-Modified`,
`ETag`, `Age`, `Cache-Control`, `x-edge-request-id`, `x-server-id`, and a content
hash of the body and of period 1.

```bash
python3 probe.py out.json 16 35     # 16 rounds, 35s apart, 4 pulls per round
```

No credential is used and none is needed.