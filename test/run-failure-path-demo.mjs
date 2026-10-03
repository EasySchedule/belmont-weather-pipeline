#!/usr/bin/env node
// A logged run of the failure path, so the behaviour is on the record as output and
// not only as an assertion in a test file.
//
//   node test/run-failure-path-demo.mjs
//
// The real pipeline runs over real HTTP. Only the host is redirected: api.met.no
// is replaced by a local server that answers the way a failing MET Norway answers.
// Nothing inside the pipeline is stubbed.

import { startStub } from './stub.mjs';

const behaviour = process.argv[2] || 'http-503';

const stub = await startStub({ metNoBehaviour: behaviour });
process.env.BELMONT_MET_NO_BASE_URL = stub.baseUrl;
process.env.BELMONT_NWS_BASE_URL = stub.baseUrl;

const { runRoundup } = await import('../src/roundup.mjs');
const artifact = await runRoundup({ edition: 'morning' });

console.log(`=== failure-path demo: MET Norway stub behaviour "${behaviour}" ===`);
console.log(`stub base url: ${stub.baseUrl}`);
console.log('');
console.log(`roundup ran            : ${artifact.ran}`);
console.log(`edition                : ${artifact.edition}`);
console.log(`sources carried        : ${artifact.sourceCount}`);
for (const source of artifact.sources) {
  console.log(
    `  - ${source.source}: ${source.organisation}, upstream ${source.upstreamRunTimeUtc}, ` +
      `retrieved ${source.retrievedAt}, ${source.upstreamAgeMinutes} min old at retrieval`,
  );
}
console.log('');
console.log('single-source reason printed in the item:');
console.log(`  ${artifact.singleSourceReason}`);
console.log('');
console.log('blockers raised:');
for (const blocker of artifact.blockers) {
  console.log(
    `  - ${blocker.source} (${blocker.organisation}) ${blocker.status ?? 'no status'} ` +
      `fatal=${blocker.fatal} deprecated=${blocker.deprecated ?? false}`,
  );
  console.log(`    endpoint: ${blocker.endpoint}`);
  console.log(`    retrievedAt: ${blocker.retrievedAt}`);
  console.log(`    detail: ${blocker.message}`);
}
console.log('');
console.log(`NWS values still in the item (the roundup did not stop):`);
const nws = artifact.sources.find((s) => s.source === 'National Weather Service');
if (nws) {
  for (const period of nws.periods) {
    console.log(
      `  - ${period.name}: ${period.temperature} ${period.temperatureUnit}, ${period.shortForecast}, ` +
        `${period.probabilityOfPrecipitationPercent}% precipitation`,
    );
  }
}
console.log('');
console.log(`comparisons emitted     : ${artifact.comparisons.length} (expected 0, nothing to compare against)`);
console.log(`disagreements to print  : ${artifact.disagreementsToPrint.length}`);
console.log(`attribution second      : ${artifact.attribution.second}`);
console.log(`endpoints contacted     : ${stub.requests.map((r) => r.url).join('  ')}`);

await stub.close();
