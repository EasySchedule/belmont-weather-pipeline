#!/usr/bin/env node
// Belmont News weather roundup pipeline.
//
//   node bin/weather-roundup.mjs --edition morning
//   node bin/weather-roundup.mjs --edition evening --out artifact.json
//   node bin/weather-roundup.mjs --edition morning --pretty
//
// Exit codes:
//   0  the roundup ran. With both sources, on one source with the reason printed,
//      and with the source of record stable across its pulls.
//   2  the source of record did not answer, so the roundup did not run.
//   3  a blocker was raised but the roundup still ran. Either the second source is
//      missing, or the source of record served two different products under one
//      stamp. The item publishes what was pulled, prints the finding and escalates.

import { runRoundup } from '../src/roundup.mjs';

function parseArgs(argv) {
  const args = { edition: 'morning', pretty: false, out: null };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--edition') args.edition = argv[++i];
    else if (token === '--out') args.out = argv[++i];
    else if (token === '--pretty') args.pretty = true;
    else if (token === '--help' || token === '-h') args.help = true;
    else throw new Error(`unknown argument: ${token}`);
  }
  return args;
}

const USAGE = `Belmont News weather roundup pipeline\n\n  --edition morning|evening   which edition the artifact feeds (default morning)\n  --out <path>                write the artifact JSON to <path>\n  --pretty                    indent the JSON\n  --help                      this text\n`;

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  process.stdout.write(USAGE);
  process.exit(0);
}

const artifact = await runRoundup({ edition: args.edition });

const json = args.pretty ? JSON.stringify(artifact, null, 2) : JSON.stringify(artifact);
if (args.out) {
  const { writeFileSync } = await import('node:fs');
  writeFileSync(args.out, `${json}\n`);
  process.stdout.write(`wrote ${args.out}\n`);
} else {
  process.stdout.write(`${json}\n`);
}

// Human-readable summary on stderr so stdout stays machine-readable.
const lines = [];
lines.push(`edition=${artifact.edition} ran=${artifact.ran} sources=${artifact.sourceCount}`);
for (const source of artifact.sources) {
  lines.push(
    `  ${source.source}: upstream=${source.upstreamRunTimeUtc} retrieved=${source.retrievedAt} ` +
      `age=${source.upstreamAgeMinutes}min`,
  );
}
if (artifact.headline) {
  const h = artifact.headline;
  lines.push(
    `  headline ${h.period} ${h.window.startLocalIso} -> ${h.window.endLocalIso}: ` +
      `NWS ${h.nws.valueFahrenheit} F vs MET ${h.metNorway.valueFahrenheit} F = ` +
      `${h.signedDifferenceFahrenheit >= 0 ? '+' : ''}${h.signedDifferenceFahrenheit} F ` +
      `withinThreshold=${h.withinThreshold} mustPrint=${h.mustPrintDisagreement}`,
  );
}
if (artifact.sourceIntegrity) {
  const si = artifact.sourceIntegrity;
  lines.push(
    `  source integrity: pulls=${si.pullCount} stable=${si.stable} ` +
      `products=${si.distinctProductFingerprints.join(',')} ` +
      `lastModified=${si.lastModifiedStamps.join(',') || 'none'} ` +
      `findings=${si.findings.length}`,
  );
  for (const finding of si.findings) lines.push(`  FINDING ${finding.kind}: ${finding.detail}`);
  if (si.confirmationPullFailed) {
    lines.push(`  confirmation pull failed: ${si.confirmationPullFailed.message}`);
  }
}
if (artifact.singleSourceReason) lines.push(`  single-source reason: ${artifact.singleSourceReason}`);
for (const blocker of artifact.blockers) {
  lines.push(`  BLOCKER ${blocker.source} ${blocker.endpoint} ${blocker.status ?? 'no status'}`);
}
process.stderr.write(`${lines.join('\n')}\n`);

if (!artifact.ran) process.exit(2);
if (artifact.blockers.some((b) => !b.fatal)) process.exit(3);
process.exit(0);
