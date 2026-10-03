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

The discriminator is the **`Accept` request header**. This endpoint keeps one
cached representation per negotiated media type, and every one of them is
stamped identically. Twelve pulls, three repeats each, byte-identical within each
variant:

| `Accept` sent | `generatedAt` | Period 1 PoP | Period 1 `shortForecast` | Tonight `startTime` | body sha |
| --- | --- | --- | --- | --- | --- |
| *(header absent)* | `2026-10-02T23:17:15+00:00` | 17 | Slight Chance Rain Showers then Mostly Cloudy | `19:00-04:00` | `26f51f4a95a2` |
| `*/*` | `2026-10-02T23:17:15+00:00` | 17 | Slight Chance Rain Showers then Mostly Cloudy | `19:00-04:00` | `26f51f4a95a2` |
| `application/json` | `2026-10-03T00:44:55+00:00` | 3 | Mostly Cloudy | `20:00-04:00` | `f0195b85e93a0` |
| `application/geo+json` | `2026-10-03T00:19:57+00:00` | 3 | Mostly Cloudy | `20:00-04:00` | `78fe4e14327d` |
| `application/geo+json; charset=utf-8` | `2026-10-03T01:16:09+00:00` | 3 | Mostly Cloudy | `21:00-04:00` | `18199759c887` |
| `text/html` | `2026-10-03T01:06:52+00:00` | 3 | Mostly Cloudy | `21:00-04:00` | `c18c22e555b6` |

Every row above carries the same two headers:

```
Last-Modified: Fri, 02 Oct 2026 22:41:34 GMT
ETag:          W/"1790980896:dtagent10337260504112723F6xZ:dtagent10337260504112723F6xZ"
Vary:          Accept,Feature-Flags,Accept-Language
```

Six requests, **five distinct bodies**, one `Last-Modified`, one `ETag`, three
distinct `generatedAt` values. The two that a desk is most likely to compare, the
`*/ *` body at 17 percent and the `application/geo+json` body at 3 percent, are
the ones this issue was filed about.

This is **deterministic, not a race**. Each `Accept` value returns the same bytes
every time. A caller that omits `Accept` and a caller that sends
`application/geo+json` get different forecasts for the same period and the same
stamp, forever, and nothing in the response says which one it received.

`Vary: Accept` is the endpoint telling the truth about itself. That header is what
makes this a representation-selection problem rather than a cache-poisoning
problem, and it is the first thing to read.

## 2. The two products, field by field

Product A, `generatedAt 2026-10-03T00:44:55+00:00`, product fingerprint
`sha256:f0195b85e93a072f766b982341b949e80f73a3a73b4a12cbedee179e8e9924fa`.

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

Note the direction of the disagreement: the stale `*/*` representation carries the
**later** `startTime` relative to nothing, but the **earlier** `generatedAt`. The
cached representation is not simply an older copy of the same forecast; it is a
different one, and the one that carries the internal 17-versus-20 narrative
disagreement.

## 3. Why the stamp cannot work

**The `ETag` is derived from `updateTime`, not from the body.**

```
etag epoch component 1790980896 = 2026-10-02T22:41:36+00:00
observed properties.updateTime  = 2026-10-02T22:41:36+00:00
observed Last-Modified          = Fri, 02 Oct 2026 22:41:34 GMT
```

Both the `ETag` and the `Last-Modified` name the same upstream `updateTime`, and
neither varies with the bytes served or with the negotiated representation. They
are upstream-timestamp validators, not body validators, so two different forecast
products legitimately carry the same one. No header on this response identifies
the product.

**The origin does not honour that `ETag` as a validator either.** A conditional
`GET` carrying `If-None-Match: W/"1790980896:..."` returns **HTTP 200 with a
full body**, not `304 Not Modified`, across 12 polls over 10 minutes. So neither a
reader nor a cache can use these headers to detect the swap.

Tested and ruled out across 48 polls:

- `Cache-Control: no-cache` and `no-cache, no-store` on every poll: changed nothing.
- `x-server-id` was `vm-cprk-api-ops-app11.ncep.noaa.gov` on every pull, so this is
  not one edge node serving a stale object while another serves a fresh one.

## 4. What this is not

- **Not a wrong number.** Nothing here says which body is correct. Product B is the
  body carrying the internal 17-versus-20 disagreement already logged in
  `corrections/2026-10.md`; its `detailedForecast` still reads "Chance of
  precipitation is 20%" beside a `probabilityOfPrecipitation` of 17. That is
  upstream's inconsistency to reconcile or report, not this desk's.
- **Not a live-transport problem.** Every pull was HTTP 200 with well-formed
  GeoJSON.
- **Not a race, and not transient.** Six requests over 15 minutes, repeated, all
  deterministic. It does not resolve.
- **Not a rounding or clock artefact.** The bodies are distinct field values, not
  the same value formatted twice.

## 5. The rule the pipeline now enforces

BEL-91 recommends the desk rule: an item citing a `Last-Modified` records the
`generatedAt` **and** a hash of the period it publishes. This is the engineering
half of that, and it does not depend on the endpoint ever being consistent.

- **`src/http.mjs`** captures the response headers that decide which product a pull
  was served, and records the `Accept` it sent with the `Content-Type` it got
  back. Before this the pipeline recorded a pull's body but not the stamp naming
  it, so the desk was citing a `Last-Modified` value the pipeline had never
  captured. A header that is absent is recorded as `null`, never inferred.
- **`src/provenance.mjs`** fingerprints every pull over exactly the fields an item
  publishes, per period and for the product as a whole. It reports a
  `last_modified_collision`, an `etag_collision`, a `generated_at_regression` when
  `generatedAt` moves backwards, and a `representation_drift` when one endpoint
  answers more than one representation for the same URL. An unrelated upstream
  field the roundup does not publish does not read as a different forecast.
- **`src/roundup.mjs`** makes a **confirmation pull** of the source of record and
  runs that check every run. One extra `GET` of a free, credential-free API is
  the cost of the item being checkable. The artifact carries a `sourceIntegrity`
  block and a `sourceCitation` block with the `generatedAt`, the `Last-Modified`,
  the `ETag`, the negotiated `Accept` and `Content-Type`, the product fingerprint,
  and a hash of the published period.
- **A finding does not stop the roundup.** The item publishes the product it
  actually pulled, records its fingerprint, prints the finding and escalates,
  which is what BEL-17 requires of an item whose source is internally
  inconsistent. It exits 3 with a non-fatal blocker. Failing the run instead
  would leave a gap where the desk has nothing to check.
- **`test/stub.mjs`** reproduces the endpoint exactly: two bodies, one
  `Last-Modified`, one `ETag`, `Vary: Accept`, the body chosen by the requested
  media type, and `generatedAt` moving backwards, in the order BEL-91 recorded.
  Exercised over real HTTP against the real pipeline.
- **`test/provenance.test.mjs`** covers the fingerprint, the collision, the
  regression, the representation drift, a stable repeat pull, a source that
  answers with no stamp at all, and both outcomes of a live run.

Suite: 36 tests, 36 pass. `node --check` clean across `bin`, `src` and `test`. CLI
`--help` smoke passes.

**This PR does not pin the representation.** BEL-94 owns that, and the one-line
`Accept` change is deliberately left there so the two do not race. This PR makes
the pipeline record which representation it asked for and notice when that
changes, so the desk is never silently handed a product it cannot name, whether or
not the pin has landed.

## 6. What still needs a human

Reporting this to NWS is a human escalation to an outside organisation, and this
run has no such mandate. The reproduction above is the input it needs: one URL,
five deterministic bodies selected by `Accept`, all under one `Last-Modified` and
one `ETag`, with the `ETag` epoch component resolving to `updateTime` and no
honouring of that `ETag` as a conditional validator.

The upstream question worth asking is narrow: the endpoint declares
`Vary: Accept` but returns an upstream-timestamp `ETag` and `Last-Modified` that
are identical across every representation. An `ETag` that does not vary with the
representation it validates is what makes this invisible to caches and to readers.

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