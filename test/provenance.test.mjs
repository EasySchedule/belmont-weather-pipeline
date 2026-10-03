// The BEL-91 contract: a stamp must identify the product it names.
//
// api.weather.gov served two different forecast bodies under one `Last-Modified`
// for grid PBZ/50,48, with `generatedAt` moving backwards between them, so an
// entry citing that stamp could not be reproduced by re-pulling the URL. These
// tests cover the engineering half of the desk rule that closes it: every pull is
// fingerprinted, the stamp a desk item cites is recorded with the product, and two
// products under one stamp are reported instead of inherited silently.
//
// The collision is exercised over real HTTP against the real pipeline, from a stub
// that serves exactly what the endpoint served on 2026-10-03.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  startStub,
  NWS_FIXTURE_BODY,
  NWS_FIXTURE_ALTERNATE_BODY,
  NWS_FIXTURE_LAST_MODIFIED,
  NWS_FIXTURE_ETAG,
} from './stub.mjs';
import {
  auditSourceIntegrity,
  canonicalJson,
  fingerprintProduct,
  fingerprintPeriodAt,
} from '../src/provenance.mjs';

async function withStub(options, fn) {
  const stub = await startStub(options);
  process.env.BELMONT_MET_NO_BASE_URL = stub.baseUrl;
  process.env.BELMONT_NWS_BASE_URL = stub.baseUrl;
  try {
    return await fn(stub);
  } finally {
    delete process.env.BELMONT_MET_NO_BASE_URL;
    delete process.env.BELMONT_NWS_BASE_URL;
    await stub.close();
  }
}

test('the same product fingerprints the same, and two products never collide', () => {
  const a = fingerprintProduct(NWS_FIXTURE_BODY.properties);
  const b = fingerprintProduct(JSON.parse(JSON.stringify(NWS_FIXTURE_BODY.properties)));
  const other = fingerprintProduct(NWS_FIXTURE_ALTERNATE_BODY.properties);

  assert.equal(a.productSha256, b.productSha256, 'key order must not change the fingerprint');
  assert.notEqual(a.productSha256, other.productSha256);
  assert.equal(a.productSha256Short.length, 16);
  assert.equal(a.periodCount, 2);
});

test('a pull is fingerprinted over what the item publishes, not over fields it ignores', () => {
  // An unrelated upstream addition must not read as a different forecast.
  const base = fingerprintProduct(NWS_FIXTURE_BODY.properties);
  const withExtra = fingerprintProduct({
    ...NWS_FIXTURE_BODY.properties,
    someNewUnpublishedField: { anything: [1, 2, 3] },
  });
  assert.equal(base.productSha256, withExtra.productSha256);

  // A change to a published field must be detected.
  const changed = fingerprintProduct({
    ...NWS_FIXTURE_BODY.properties,
    periods: NWS_FIXTURE_BODY.properties.periods.map((period, index) =>
      index === 0 ? { ...period, shortForecast: 'Light Rain' } : period,
    ),
  });
  assert.notEqual(base.productSha256, changed.productSha256);
});

test('the published period is hashed on its own, so a single-period change is visible', () => {
  const first = fingerprintPeriodAt(
    NWS_FIXTURE_BODY.properties,
    NWS_FIXTURE_BODY.properties.periods[0].startTime,
  );
  const other = fingerprintPeriodAt(
    NWS_FIXTURE_ALTERNATE_BODY.properties,
    NWS_FIXTURE_BODY.properties.periods[0].startTime,
  );

  assert.equal(first.number, 1);
  assert.notEqual(first.sha256, other.sha256, 'the BEL-91 period-1 change must change the hash');
});

test('two bodies under one Last-Modified are reported as a collision', () => {
  const pulls = [
    {
      endpoint: 'https://api.weather.gov/gridpoints/PBZ/50,48/forecast',
      retrievedAt: '2026-10-03T00:44:54.000Z',
      headers: { 'last-modified': NWS_FIXTURE_LAST_MODIFIED, etag: NWS_FIXTURE_ETAG },
      fingerprint: fingerprintProduct(NWS_FIXTURE_ALTERNATE_BODY.properties),
    },
    {
      endpoint: 'https://api.weather.gov/gridpoints/PBZ/50,48/forecast',
      retrievedAt: '2026-10-03T00:46:51.000Z',
      headers: { 'last-modified': NWS_FIXTURE_LAST_MODIFIED, etag: NWS_FIXTURE_ETAG },
      fingerprint: fingerprintProduct(NWS_FIXTURE_BODY.properties),
    },
  ];

  const audit = auditSourceIntegrity(pulls);
  assert.equal(audit.stable, false);
  assert.equal(audit.distinctProductsReturned, true);
  assert.equal(audit.lastModifiedCollisions.length, 1);
  assert.equal(audit.lastModifiedCollisions[0].stamp, NWS_FIXTURE_LAST_MODIFIED);
  assert.equal(audit.lastModifiedCollisions[0].distinctProducts.length, 2);
  assert.ok(audit.findings.some((f) => f.kind === 'last_modified_collision'));
  assert.ok(audit.findings.some((f) => f.kind === 'etag_collision'));
});

test('generatedAt moving backwards is reported as a regression', () => {
  // Exactly the BEL-91 sequence: the 00:19:57 generation is pulled first, then the
  // 23:17:15 generation is pulled later, so generatedAt moves backwards in time.
  const audit = auditSourceIntegrity([
    {
      retrievedAt: '2026-10-03T00:44:54.000Z',
      headers: { 'last-modified': NWS_FIXTURE_LAST_MODIFIED },
      fingerprint: fingerprintProduct(NWS_FIXTURE_ALTERNATE_BODY.properties),
    },
    {
      retrievedAt: '2026-10-03T00:46:51.000Z',
      headers: { 'last-modified': NWS_FIXTURE_LAST_MODIFIED },
      fingerprint: fingerprintProduct(NWS_FIXTURE_BODY.properties),
    },
  ]);

  assert.equal(audit.generatedAtRegressions.length, 1);
  assert.equal(audit.generatedAtRegressions[0].earlierGeneratedAt, '2026-10-03T00:19:57+00:00');
  assert.equal(audit.generatedAtRegressions[0].laterGeneratedAt, '2026-10-02T23:17:15+00:00');
  assert.ok(audit.generatedAtRegressions[0].minutes > 0);
});

test('an identical repeat pull is stable, and a missing stamp is not treated as a value', () => {
  const fingerprint = fingerprintProduct(NWS_FIXTURE_BODY.properties);
  const stable = auditSourceIntegrity([
    { retrievedAt: '2026-10-03T01:00:00.000Z', headers: { 'last-modified': 'x' }, fingerprint },
    { retrievedAt: '2026-10-03T01:01:00.000Z', headers: { 'last-modified': 'x' }, fingerprint },
  ]);
  assert.equal(stable.stable, true);
  assert.deepEqual(stable.findings, []);

  // No stamp at all is an absent header, not a fresh one, so nothing is claimed.
  const unstamped = auditSourceIntegrity([
    { retrievedAt: '2026-10-03T01:00:00.000Z', headers: {}, fingerprint },
  ]);
  assert.equal(unstamped.lastModifiedStamps.length, 0);
  assert.equal(unstamped.observations[0].lastModified, null);
});

test('canonicalJson is stable across key order', () => {
  assert.equal(
    canonicalJson({ b: 1, a: [2, { d: 4, c: 3 }] }),
    canonicalJson({ a: [2, { c: 3, d: 4 }], b: 1 }),
  );
});

test('the pipeline records the stamp it is asked to cite, and a stable source stays exit 0', async () => {
  await withStub({ metNoBehaviour: 'ok', nwsBehaviour: 'ok' }, async () => {
    const { runRoundup } = await import('../src/roundup.mjs');
    const artifact = await runRoundup({ edition: 'morning' });

    assert.equal(artifact.ran, true);
    assert.equal(artifact.sourceIntegrity.stable, true);
    assert.equal(artifact.sourceIntegrity.findings.length, 0);
    assert.ok(artifact.sourceIntegrity.pullCount >= 2, 'a confirmation pull is made');

    const citation = artifact.sourceCitation;
    assert.equal(citation.sourceOfRecord, 'National Weather Service');
    assert.equal(citation.grid, 'PBZ/50,48');
    assert.equal(citation.generatedAt, '2026-10-02T23:17:15+00:00');
    assert.equal(citation.lastModified, NWS_FIXTURE_LAST_MODIFIED);
    assert.equal(citation.etag, 'W/"1790980896:dtagent10337260504112723F6xZ"');
    assert.ok(citation.productSha256, 'the product is identified, not only the stamp');
    assert.equal(citation.publishedPeriod.number, 1);
    assert.ok(citation.publishedPeriod.sha256);
    assert.equal(citation.stampIdentifiesProduct, true);
  });
});

test('the endpoint that served two bodies under one stamp is detected in a live run', async () => {
  await withStub({ metNoBehaviour: 'ok', nwsBehaviour: 'two-bodies-one-stamp' }, async () => {
    const { runRoundup } = await import('../src/roundup.mjs');
    const artifact = await runRoundup({ edition: 'morning' });

    assert.equal(artifact.ran, true, 'the roundup still runs, because the desk has to check it');
    assert.equal(artifact.sourceIntegrity.stable, false);
    assert.equal(artifact.sourceIntegrity.lastModifiedCollisions.length, 1);
    assert.ok(artifact.sourceIntegrity.etagCollisions.length >= 1);
    assert.ok(artifact.sourceIntegrity.generatedAtRegressions.length >= 1);
    // The confirmation pull came back as the other body: same stamp, other product.
    assert.notEqual(
      artifact.sourceIntegrity.confirmationPull.productSha256Short,
      artifact.sourceCitation.productSha256Short,
    );
    assert.equal(
      artifact.sourceIntegrity.confirmationPull.lastModified,
      artifact.sourceCitation.lastModified,
    );

    // The disagreement is printed and escalated, not resolved.
    const blocker = artifact.blockers.find((b) => b.kind === 'last_modified_collision');
    assert.ok(blocker, 'a finding is raised as a blocker');
    assert.equal(blocker.fatal, false);
    assert.ok(blocker.reason.includes('does not resolve it'));
  });
});

test('a source that answers with no stamp at all records null, not a fabricated value', async () => {
  await withStub({ metNoBehaviour: 'ok', nwsBehaviour: 'no-last-modified' }, async () => {
    const { runRoundup } = await import('../src/roundup.mjs');
    const artifact = await runRoundup({ edition: 'morning' });

    assert.equal(artifact.sourceCitation.lastModified, null);
    assert.equal(artifact.sourceCitation.generatedAt, '2026-10-02T23:17:15+00:00');
    assert.equal(artifact.sourceCitation.stampIdentifiesProduct, true);
  });
});
test('the representation a pull asked for is recorded, so a citation can name it', async () => {
  await withStub({ metNoBehaviour: 'ok', nwsBehaviour: 'ok' }, async () => {
    const { runRoundup } = await import('../src/roundup.mjs');
    const artifact = await runRoundup({ edition: 'morning' });

    assert.equal(artifact.sourceCitation.accept, 'application/json');
    assert.ok(artifact.sourceCitation.contentType, 'the representation that came back is named');
    assert.deepEqual(artifact.sourceIntegrity.requestAccept, ['application/json']);
    assert.equal(artifact.sourceIntegrity.responseContentTypes.length, 1);
    assert.equal(
      artifact.sourceIntegrity.representationDrifts.length,
      0,
      'one pinned representation is not drift',
    );
  });
});

test('a body chosen by the Accept header is reported as representation drift, not a mystery', () => {
  const audit = auditSourceIntegrity([
    {
      retrievedAt: '2026-10-03T01:16:26.000Z',
      headers: { 'last-modified': NWS_FIXTURE_LAST_MODIFIED, accept: '*/*', contentType: 'application/json' },
      fingerprint: fingerprintProduct(NWS_FIXTURE_BODY.properties),
    },
    {
      retrievedAt: '2026-10-03T01:16:33.000Z',
      headers: {
        'last-modified': NWS_FIXTURE_LAST_MODIFIED,
        accept: 'application/geo+json',
        contentType: 'application/geo+json; charset=utf-8',
      },
      fingerprint: fingerprintProduct(NWS_FIXTURE_ALTERNATE_BODY.properties),
    },
  ]);

  assert.equal(audit.stable, false);
  assert.equal(audit.representationDrifts.length, 1);
  const drift = audit.representationDrifts[0];
  assert.deepEqual(drift.requestAccept.sort(), ['*/*', 'application/geo+json']);
  assert.equal(drift.distinctProductsPerContentType.length, 2);
  assert.ok(drift.detail.includes('does not identify the product'));
});

test('the stub picks the body by Accept and stamps both identically', async () => {
  await withStub({ metNoBehaviour: 'ok', nwsBehaviour: 'per-representation' }, async (stub) => {
    const geo = await fetch(`${stub.baseUrl}/gridpoints/PBZ/50,48/forecast`, {
      headers: { Accept: 'application/geo+json' },
    });
    const any = await fetch(`${stub.baseUrl}/gridpoints/PBZ/50,48/forecast`, { headers: { Accept: '*/*' } });
    const geoBody = await geo.json();
    const anyBody = await any.json();

    assert.equal(geo.headers.get('last-modified'), any.headers.get('last-modified'));
    assert.notEqual(
      geoBody.properties.periods[0].probabilityOfPrecipitation.value,
      anyBody.properties.periods[0].probabilityOfPrecipitation.value,
    );
    assert.notEqual(geo.headers.get('content-type'), any.headers.get('content-type'));
  });
});
