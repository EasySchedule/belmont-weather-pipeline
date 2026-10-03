// The failure path, exercised rather than described.
//
// Each test runs the real pipeline over real HTTP against a local stub that
// stands in for api.met.no. Nothing inside the pipeline is mocked: the failure is
// a real HTTP status the pull code has to survive.

import test from 'node:test';
import assert from 'node:assert/strict';

import { startStub } from './stub.mjs';

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

async function runPipeline() {
  // Imported inside the test so the env vars above are already set. Base URLs and
  // the User-Agent are resolved at call time, so this is a real load, not a race.
  const { runRoundup } = await import('../src/roundup.mjs');
  return runRoundup({ edition: 'morning' });
}

test('MET Norway HTTP 503: the roundup still runs on NWS, with the single-source reason and a blocker', async () => {
  await withStub({ metNoBehaviour: 'http-503' }, async (stub) => {
    const artifact = await runPipeline();

    // The roundup ran.
    assert.equal(artifact.ran, true);
    assert.equal(artifact.edition, 'morning');

    // Exactly one source is carried, and it is the source of record.
    assert.equal(artifact.sourceCount, 1);
    assert.equal(artifact.sources.length, 1);
    assert.equal(artifact.sources[0].source, 'National Weather Service');
    assert.equal(artifact.sources[0].grid, 'PBZ/50,48');
    assert.equal(artifact.sources[0].generatedAt, undefined);
    assert.equal(artifact.sources[0].upstreamRunTimeUtc, '2026-10-02T23:17:15+00:00');

    // The reason names MET Norway and the endpoint.
    assert.match(artifact.singleSourceReason, /MET Norway/);
    assert.match(artifact.singleSourceReason, /Norwegian Meteorological Institute/);
    assert.match(artifact.singleSourceReason, /locationforecast\/2\.0\/compact\?lat=40\.1006&lon=-80\.8501/);
    assert.match(artifact.singleSourceReason, /HTTP 503/);
    assert.match(artifact.singleSourceReason, /No mirror, aggregator, or cached earlier pull is substituted/);

    // A blocker naming the failed endpoint was raised, and it is not fatal.
    const blockers = artifact.blockers.filter((b) => b.source === 'MET Norway');
    assert.equal(blockers.length, 1);
    assert.equal(blockers[0].status, 503);
    assert.equal(blockers[0].fatal, false);
    assert.match(blockers[0].endpoint, /locationforecast\/2\.0\/compact/);
    assert.ok(blockers[0].retrievedAt, 'the blocker carries the retrieval time of the failed pull');

    // No comparison is fabricated from a source that did not answer.
    assert.deepEqual(artifact.comparisons, []);
    assert.equal(artifact.headline, null);
    assert.equal(artifact.attribution.second, null);
    assert.deepEqual(artifact.disagreementsToPrint, []);

    // No mirror or aggregator was quietly substituted: exactly two hosts were
    // contacted, both of them the endpoints of record.
    const urls = stub.requests.map((r) => r.url).sort();
    assert.deepEqual(urls, [
      '/gridpoints/PBZ/50,48/forecast',
      '/weatherapi/locationforecast/2.0/compact?lat=40.1006&lon=-80.8501',
    ]);
  });
});

test('MET Norway HTTP 403: same single-source behaviour, status reported', async () => {
  await withStub({ metNoBehaviour: 'http-403' }, async () => {
    const artifact = await runPipeline();
    assert.equal(artifact.ran, true);
    assert.equal(artifact.sourceCount, 1);
    assert.match(artifact.singleSourceReason, /HTTP 403/);
    assert.equal(artifact.blockers.find((b) => b.source === 'MET Norway').status, 403);
  });
});

test('MET Norway HTTP 203: a deprecated version is not read as a normal answer', async () => {
  await withStub({ metNoBehaviour: 'http-203' }, async (stub) => {
    const artifact = await runPipeline();
    assert.equal(artifact.ran, true);
    assert.equal(artifact.sourceCount, 1, '203 must not add a second source');
    const blocker = artifact.blockers.find((b) => b.source === 'MET Norway');
    assert.equal(blocker.status, 203);
    assert.equal(blocker.deprecated, true);
    assert.match(artifact.singleSourceReason, /HTTP 203/);
    assert.match(artifact.singleSourceReason, /deprecated API version, not a normal answer/);
    // The body served with the 203 was not used as data.
    assert.equal(artifact.comparisons.length, 0);
    assert.ok(stub.requests.some((r) => r.url.includes('locationforecast')));
  });
});

test('MET Norway HTTP 200 with an empty body is a failed pull, not a source', async () => {
  await withStub({ metNoBehaviour: 'empty-200' }, async () => {
    const artifact = await runPipeline();
    assert.equal(artifact.ran, true);
    assert.equal(artifact.sourceCount, 1);
    assert.match(artifact.singleSourceReason, /empty body/);
    assert.ok(artifact.blockers.some((b) => b.source === 'MET Norway'));
  });
});

test('MET Norway HTTP 200 with no timeseries is a failed pull', async () => {
  await withStub({ metNoBehaviour: 'no-timeseries' }, async () => {
    const artifact = await runPipeline();
    assert.equal(artifact.ran, true);
    assert.equal(artifact.sourceCount, 1);
    assert.match(artifact.singleSourceReason, /no timeseries/);
  });
});

test('MET Norway unreachable: a transport failure is handled like any other', async () => {
  const stub = await startStub({ metNoBehaviour: 'ok' });
  const deadPort = stub.baseUrl.replace(/:\d+$/, ':1');
  await stub.close();
  process.env.BELMONT_NWS_BASE_URL = deadPort;
  process.env.BELMONT_MET_NO_BASE_URL = deadPort;
  try {
    const { runRoundup } = await import('../src/roundup.mjs');
    const artifact = await runRoundup({ edition: 'morning' });
    // NWS itself failed, so the roundup does not run with invented numbers.
    assert.equal(artifact.ran, false);
    assert.equal(artifact.sources.length, 0);
    const blocker = artifact.blockers.find((b) => b.source === 'National Weather Service');
    assert.equal(blocker.fatal, true);
    assert.match(blocker.reason, /does not run with invented numbers/);
  } finally {
    delete process.env.BELMONT_MET_NO_BASE_URL;
    delete process.env.BELMONT_NWS_BASE_URL;
  }
});

test('the NWS single-source path names MET Norway as the source that did not answer', async () => {
  // NWS answers, MET Norway does not: the exact state this pipeline closes, and
  // the reason is printed rather than implied.
  await withStub({ metNoBehaviour: 'http-503' }, async () => {
    const artifact = await runPipeline();
    assert.match(artifact.singleSourceReason, /only one answered/);
    assert.equal(artifact.attribution.second, null);
    assert.match(artifact.attribution.publisher, /MET Norway is a source, never the publisher/);
  });
});
