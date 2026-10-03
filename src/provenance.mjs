// Product fingerprints and stamp-collision detection.
//
// BEL-17 section 2 makes the National Weather Service API the source of record
// and requires an entry to cite the `generatedAt` of the pull actually used. A
// `generatedAt` alone is not reproducible on its own: the BEL-91 escalation
// recorded two different forecast bodies served under one `Last-Modified`, with
// `generatedAt` moving backwards between them, so a citation of `generatedAt`
// cannot be checked by re-pulling the URL.
//
// This module is the engineering half of the desk rule that issue asks for. Every
// pull is fingerprinted over the periods it would publish, and any two pulls that
// share a `Last-Modified` or an `ETag` but not a fingerprint are reported as a
// collision. The rule does not depend on the endpoint being consistent: it
// notices the inconsistency instead of inheriting it silently.

import { createHash } from 'node:crypto';

// Stable serialisation. Two pulls of the same product must fingerprint the same
// regardless of key order, so every object is sorted before it is hashed.
export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
}

export const sha256Hex = (text) => createHash('sha256').update(text, 'utf8').digest('hex');

// Short form for printing and for the artifact. The full digest stays available
// so a claim of "the same product" can be re-derived and checked by hand.
export const shortHash = (hex) => (typeof hex === 'string' ? hex.slice(0, 16) : null);

// The fingerprint covers exactly what an entry would publish from this pull, not
// the whole payload: the upstream stamp, and every published field of every
// period. Fields the pipeline does not publish are excluded on purpose, so an
// unrelated addition upstream does not read as a different forecast.
const PUBLISHED_PERIOD_FIELDS = [
  'number',
  'name',
  'startTime',
  'endTime',
  'isDaytime',
  'temperature',
  'temperatureUnit',
  'shortForecast',
  'windSpeed',
  'windDirection',
];

export function fingerprintProduct(properties = {}) {
  const periods = Array.isArray(properties.periods) ? properties.periods : [];

  const periodFingerprints = periods.map((period) => {
    const published = {};
    for (const field of PUBLISHED_PERIOD_FIELDS) {
      if (period[field] !== undefined) published[field] = period[field];
    }
    // Precipitation is published by the roundup, so it belongs in the hash.
    const pop = period.probabilityOfPrecipitation;
    published.probabilityOfPrecipitationPercent =
      pop && typeof pop === 'object' ? (pop.value ?? null) : (pop ?? null);
    return {
      number: period.number ?? null,
      startTime: period.startTime ?? null,
      sha256: sha256Hex(canonicalJson(published)),
    };
  });

  const identity = {
    generatedAt: properties.generatedAt ?? null,
    updateTime: properties.updateTime ?? null,
    validTimes: properties.validTimes ?? null,
    periods: periodFingerprints,
  };

  return {
    productSha256: sha256Hex(canonicalJson(identity)),
    productSha256Short: shortHash(sha256Hex(canonicalJson(identity))),
    generatedAt: properties.generatedAt ?? null,
    updateTime: properties.updateTime ?? null,
    validTimes: properties.validTimes ?? null,
    periodCount: periodFingerprints.length,
    periodFingerprints,
  };
}

// The period a desk item is most likely to quote: the one covering the instant the
// entry is written about. Hashing it separately means a later pull that returns a
// different product is detectable from the published number alone.
export function fingerprintPeriodAt(properties = {}, instantIso) {
  const instant = Date.parse(instantIso);
  const periods = Array.isArray(properties.periods) ? properties.periods : [];
  const match =
    periods.find((period) => {
      const start = Date.parse(period.startTime);
      const end = Date.parse(period.endTime);
      return !Number.isNaN(start) && !Number.isNaN(end) && instant >= start && instant < end;
    }) || periods[0] || null;
  if (!match) return null;
  const published = {};
  for (const field of PUBLISHED_PERIOD_FIELDS) {
    if (match[field] !== undefined) published[field] = match[field];
  }
  const pop = match.probabilityOfPrecipitation;
  published.probabilityOfPrecipitationPercent =
    pop && typeof pop === 'object' ? (pop.value ?? null) : (pop ?? null);
  return {
    number: match.number ?? null,
    name: match.name ?? null,
    startTime: match.startTime ?? null,
    probabilityOfPrecipitationPercent:
      published.probabilityOfPrecipitationPercent ?? null,
    shortForecast: match.shortForecast ?? null,
    sha256: sha256Hex(canonicalJson(published)),
  };
}

// One observed pull, in the shape the detector reads.
export function observePull({ endpoint, retrievedAt, headers = {}, fingerprint }) {
  return {
    endpoint: endpoint ?? null,
    retrievedAt: retrievedAt ?? null,
    lastModified: headers['last-modified'] ?? null,
    etag: headers.etag ?? null,
    date: headers.date ?? null,
    age: headers.age ?? null,
    cacheControl: headers['cache-control'] ?? null,
    accept: headers.accept ?? null,
    contentType: headers.contentType ?? null,
    vary: headers.vary ?? null,
    serverId: headers['x-server-id'] ?? null,
    edgeRequestId: headers['x-edge-request-id'] ?? null,
    requestId: headers['x-request-id'] ?? null,
    generatedAt: fingerprint?.generatedAt ?? null,
    updateTime: fingerprint?.updateTime ?? null,
    productSha256: fingerprint?.productSha256 ?? null,
    productSha256Short: fingerprint?.productSha256Short ?? null,
  };
}

// A pipeline source record already carries the flattened stamp and fingerprint,
// so map that shape onto the detector's input rather than reshaping every caller.
export function observationFrom(source) {
  if (!source) return null;
  return observePull({
    endpoint: source.endpoint,
    retrievedAt: source.retrievedAt,
    headers: {
      'last-modified': source.lastModified,
      etag: source.etag,
      date: source.responseHeaders?.date ?? null,
      age: source.responseHeaders?.age ?? null,
      'cache-control': source.responseHeaders?.['cache-control'] ?? null,
      contentType: source.contentType ?? source.responseHeaders?.['content-type'] ?? null,
      vary: source.responseHeaders?.vary ?? null,
      accept: source.accept ?? null,
      'x-server-id': source.responseHeaders?.['x-server-id'] ?? null,
      'x-edge-request-id': source.responseHeaders?.['x-edge-request-id'] ?? null,
      'x-request-id': source.responseHeaders?.['x-request-id'] ?? null,
    },
    fingerprint: {
      generatedAt: source.upstreamRunTimeUtc ?? source.generatedAt ?? null,
      updateTime: source.updateTimeUtc ?? source.updateTime ?? null,
      productSha256: source.productSha256 ?? null,
      productSha256Short: source.productSha256Short ?? null,
    },
  });
}

const stampCollision = (label, pulls) => {
  const byStamp = new Map();
  for (const pull of pulls) {
    const stamp = pull[label];
    if (!stamp) continue;
    if (!byStamp.has(stamp)) byStamp.set(stamp, new Map());
    const byProduct = byStamp.get(stamp);
    if (!byProduct.has(pull.productSha256Short)) {
      byProduct.set(pull.productSha256Short, { pulls: [], generatedAtSet: new Set() });
    }
    const entry = byProduct.get(pull.productSha256Short);
    entry.pulls.push(pull);
    if (pull.generatedAt) entry.generatedAtSet.add(pull.generatedAt);
  }

  const collisions = [];
  for (const [stamp, byProduct] of byStamp) {
    if (byProduct.size < 2) continue;
    collisions.push({
      stamp,
      distinctProducts: [...byProduct.entries()].map(([product, entry]) => ({
        productSha256Short: product,
        generatedAt: [...entry.generatedAtSet].sort(),
        pulledAt: entry.pulls.map((p) => p.retrievedAt).sort(),
      })),
      detail:
        `${byProduct.size} different forecast bodies were served under one ` +
        `${label === 'lastModified' ? 'Last-Modified' : 'ETag'} value (${stamp}). ` +
        `The stamp does not identify the product, so a citation of it is not reproducible.`,
    });
  }
  return collisions;
};

// `generatedAt` moving backwards cannot happen inside one generation lineage, so
// a regression across pulls is evidence of two lineages sharing one stamp rather
// than of the endpoint simply not having updated yet.
const generatedAtRegression = (pulls) => {
  const ordered = [...pulls].sort(
    (a, b) => Date.parse(a.retrievedAt || 0) - Date.parse(b.retrievedAt || 0),
  );
  const regressions = [];
  let highest = null;
  for (const pull of ordered) {
    const value = Date.parse(pull.generatedAt || '');
    if (Number.isNaN(value)) continue;
    if (highest !== null && value < highest.value) {
      regressions.push({
        earlierPull: highest.pull.retrievedAt,
        earlierGeneratedAt: highest.pull.generatedAt,
        laterPull: pull.retrievedAt,
        laterGeneratedAt: pull.generatedAt,
        minutes: Math.round((highest.value - value) / 60000),
        detail:
          `generatedAt went backwards from ${highest.pull.generatedAt} at ` +
          `${highest.pull.retrievedAt} to ${pull.generatedAt} at ${pull.retrievedAt}. ` +
          `That cannot happen inside one generation lineage.`,
      });
    }
    if (highest === null || value > highest.value) highest = { value, pull };
  }
  return regressions;
};

// This endpoint serves a different body per negotiated media type, all of them
// under one stamp (BEL-94). Two pulls of one endpoint that came back as
// different representations are not two forecasts disagreeing; they are one URL
// answering two questions. Naming that is the difference between an actionable
// report and a mystery.
const representationDrift = (pulls) => {
  const types = [...new Set(pulls.map((p) => p.contentType).filter(Boolean))];
  const accepts = [...new Set(pulls.map((p) => p.accept).filter(Boolean))];
  if (types.length + accepts.length < 2) return [];
  const byType = new Map();
  for (const pull of pulls) {
    if (!pull.contentType) continue;
    if (!byType.has(pull.contentType)) byType.set(pull.contentType, new Set());
    byType.get(pull.contentType).add(pull.productSha256Short);
  }
  const productsPerType = [...byType.entries()].filter(([, set]) => set.size > 1);
  if (types.length < 2 && productsPerType.length === 0) return [];
  return [
    {
      kind: 'representation_drift',
      requestAccept: accepts,
      responseContentType: types,
      distinctProductsPerContentType: [...byType.entries()].map(([type, set]) => ({
        contentType: type,
        products: [...set],
      })),
      detail:
        `This endpoint answered ${types.length} representation(s) for the same URL under one ` +
        `stamp: ${types.join(' | ')}. The bodies differ, so the stamp does not identify the ` +
        `product and a citation of it cannot be reproduced by re-pulling the URL.`,
    },
  ];
};

// The whole check. Reads only what the pulls observed, so it runs on a single
// confirmation pull and on a longer series alike, and returns an object that says
// plainly whether the source was stable across the pulls made.
export function auditSourceIntegrity(pulls = []) {
  const observations = pulls
    .filter(Boolean)
    .map((pull) => (pull.productSha256Short ? observationFrom(pull) : observePull(pull)))
    .filter(Boolean);
  const lastModifiedCollisions = stampCollision('lastModified', observations);
  const etagCollisions = stampCollision('etag', observations);
  const generatedAtRegressions = generatedAtRegression(observations);
  const representationDrifts = representationDrift(observations);

  const fingerprints = [...new Set(observations.map((p) => p.productSha256Short).filter(Boolean))];
  const generatedAts = [...new Set(observations.map((p) => p.generatedAt).filter(Boolean))].sort();
  const stamps = [...new Set(observations.map((p) => p.lastModified).filter(Boolean))];
  const contentTypes = [...new Set(observations.map((p) => p.contentType).filter(Boolean))];

  const findings = [
    ...lastModifiedCollisions.map((c) => ({ kind: 'last_modified_collision', ...c })),
    ...etagCollisions.map((c) => ({ kind: 'etag_collision', ...c })),
    ...generatedAtRegressions.map((r) => ({ kind: 'generated_at_regression', ...r })),
    ...representationDrifts,
  ];

  // Only a real disagreement between two bodies of the same endpoint counts.
  const distinctProducts =
    new Set(observations.map((p) => p.productSha256)).size > 1;

  return {
    checked: 'Product fingerprints of every pull of the source of record, compared by stamp.',
    rule:
      'Every weather item citing a Last-Modified value records the generatedAt of the pull ' +
      'actually used and the fingerprint of the period it publishes, so a later pull that ' +
      'returns a different product is detectable rather than invisible.',
    pullCount: observations.length,
    observations,
    distinctProductFingerprints: fingerprints,
    distinctGeneratedAt: generatedAts,
    lastModifiedStamps: stamps,
    requestAccept: [...new Set(observations.map((p) => p.accept).filter(Boolean))],
    responseContentTypes: contentTypes,
    stable: findings.length === 0 && !distinctProducts,
    distinctProductsReturned: distinctProducts,
    findings,
    lastModifiedCollisions,
    etagCollisions,
    generatedAtRegressions,
    representationDrifts,
  };
}