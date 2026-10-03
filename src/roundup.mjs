// The roundup pipeline.
//
// Two named sources are pulled on every run. If MET Norway does not answer, the
// roundup does not fail and it does not silently become a one-source item with no
// explanation: it prints the single-source reason naming MET Norway and the
// endpoint, raises a blocker naming the failed endpoint, and still runs on NWS.
// No mirror, aggregator, or cached earlier pull is substituted.

import { NWS, MET_NO, TEMPERATURE_PRINT_THRESHOLD_F, TIME_ZONE, userAgent } from './constants.mjs';
import { pullNws } from './nws.mjs';
import { pullMetNo } from './metno.mjs';
import { compareAll, headlineComparison } from './compare.mjs';
import { PullFailure } from './http.mjs';

export async function runRoundup({ edition = 'morning', now = null } = {}) {
  const startedAt = (now || new Date()).toISOString();
  const blockers = [];
  const sources = [];
  let nws = null;
  let met = null;

  // Source of record, first. If NWS does not answer the roundup does not run with
  // invented numbers.
  try {
    nws = await pullNws();
    sources.push(nws);
  } catch (error) {
    blockers.push({
      source: 'National Weather Service',
      organisation: NWS.office,
      endpoint: NWS.forecastUrl,
      status: error instanceof PullFailure ? error.status : null,
      message: error.message,
      retrievedAt: error instanceof PullFailure ? error.retrievedAt : startedAt,
      userAgent: error instanceof PullFailure ? error.userAgent : null,
      fatal: true,
      reason: `The source of record did not answer. The roundup does not run with invented numbers.`,
    });
    return {
      edition,
      ran: false,
      startedAt,
      finishedAt: new Date().toISOString(),
      sources,
      comparisons: [],
      headline: null,
      singleSourceReason: null,
      blockers,
    };
  }

  // Second independent source.
  try {
    met = await pullMetNo();
    sources.push(met);
  } catch (error) {
    const deprecated = error instanceof PullFailure && error.deprecated;
    const endpoint = error instanceof PullFailure ? error.endpoint : MET_NO.url;
    const status = error instanceof PullFailure ? error.status : null;
    const singleSourceReason =
      `Two named sources are required for Belmont News weather copy and only one answered. ` +
      `The second independent source, ${MET_NO.organisation} (MET Norway), did not answer at ` +
      `\`${endpoint}\`` +
      (status ? ` (HTTP ${status})` : '') +
      `. ${deprecated ? 'HTTP 203 means a deprecated API version, not a normal answer, and is not used as data. ' : ''}` +
      `This roundup therefore names the National Weather Service as the source of record and prints ` +
      `the reason only one source exists. No mirror, aggregator, or cached earlier pull is substituted. ` +
      `Pull detail: ${error.message}`;
    blockers.push({
      source: 'MET Norway',
      organisation: MET_NO.organisation,
      endpoint,
      status,
      deprecated: Boolean(deprecated),
      message: error.message,
      retrievedAt: error instanceof PullFailure ? error.retrievedAt : startedAt,
      userAgent: error instanceof PullFailure ? error.userAgent : null,
      fatal: false,
      reason: singleSourceReason,
    });
    met = null;
  }

  const comparisons = met ? compareAll(nws, met) : [];
  const headline = met ? headlineComparison(comparisons) : null;
  const printedDisagreements = comparisons.filter((c) => c.mustPrintDisagreement);

  const artifact = {
    edition,
    ran: true,
    startedAt,
    finishedAt: new Date().toISOString(),
    timeZone: TIME_ZONE,
    newsroomUserAgent: userAgent(),
    credentialUsed: null,
    pointOfRecord: {
      label: NWS.point.label,
      latitude: NWS.point.latitude,
      longitude: NWS.point.longitude,
      county: 'Belmont County, Ohio',
    },
    sources,
    sourceCount: sources.length,
    singleSourceReason: sources.length === 1 ? blockers[0]?.reason || null : null,
    comparisons,
    headline,
    headlineSignedDifferenceFahrenheit: headline ? headline.signedDifferenceFahrenheit : null,
    withinThreshold: headline ? headline.withinThreshold : null,
    thresholdFahrenheit: TEMPERATURE_PRINT_THRESHOLD_F,
    disagreementsToPrint: printedDisagreements.map((c) => ({
      period: c.period,
      window: c.window,
      reconciliation: c.reconciliation,
    })),
    upstreamAges: {
      note: 'How old each source own run was at the moment of that pull. This is what shows a disagreement is two forecast productions rather than one source quoting a stale run.',
      nws: nws.upstreamRunTimeUtc
        ? { upstreamRunTimeUtc: nws.upstreamRunTimeUtc, retrievedAt: nws.retrievedAt, ageMinutes: nws.upstreamAgeMinutes }
        : null,
      metNorway: met
        ? { upstreamRunTimeUtc: met.upstreamRunTimeUtc, retrievedAt: met.retrievedAt, ageMinutes: met.upstreamAgeMinutes }
        : null,
    },
    attribution: {
      primary: `National Weather Service, ${NWS.office}, grid ${NWS.grid}, forecast zone ${NWS.forecastZone}, county zone ${NWS.countyZone}`,
      second: met ? `${MET_NO.attribution}, credited to ${MET_NO.organisation} (${MET_NO.licence})` : null,
      publisher: 'Belmont News publishes this item. MET Norway is a source, never the publisher.',
    },
    blockers,
  };

  return artifact;
}
