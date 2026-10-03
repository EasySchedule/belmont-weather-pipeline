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
import { auditSourceIntegrity } from './provenance.mjs';
import { PullFailure } from './http.mjs';

export async function runRoundup({ edition = 'morning', now = null, confirmSource = true } = {}) {
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

  // A confirmation pull of the source of record, and the integrity check built on
  // it. BEL-91 recorded two different forecast bodies served under one
  // `Last-Modified`, with `generatedAt` moving backwards, so the stamp a desk item
  // cites does not identify the product it was given. A single pull cannot show
  // that; a second pull of the same endpoint minutes apart can. One extra GET of a
  // free, credential-free public API is the cost of the item being checkable.
  //
  // A finding here does not stop the roundup. The item still publishes a stated
  // field value, prints the disagreement and escalates, which is what BEL-17
  // requires of an item when its source is internally inconsistent. Failing the
  // run instead would leave a gap where the desk has nothing to check.
  const integrityPulls = [nws];
  let confirmation = null;
  let confirmationFailed = null;
  if (confirmSource) {
    try {
      confirmation = await pullNws();
      integrityPulls.push(confirmation);
    } catch (error) {
      confirmationFailed = {
        message: error.message,
        retrievedAt: error instanceof PullFailure ? error.retrievedAt : new Date().toISOString(),
      };
    }
  }
  const sourceIntegrity = auditSourceIntegrity(integrityPulls);

  for (const finding of sourceIntegrity.findings) {
    blockers.push({
      source: 'National Weather Service',
      organisation: NWS.office,
      endpoint: NWS.forecastUrl,
      status: null,
      message: finding.detail,
      retrievedAt: startedAt,
      userAgent: null,
      fatal: false,
      kind: finding.kind,
      reason:
        `The source of record returned two different forecast products under one stamp, so the ` +
        `stamp cannot identify what an item was given. This roundup publishes the product it ` +
        `actually pulled, records its fingerprint, and prints this disagreement. It does not ` +
        `resolve it and it does not claim the disagreement is gone. Finding: ${finding.detail}`,
    });
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
    sourceIntegrity: {
      ...sourceIntegrity,
      confirmationPull: confirmation
        ? {
            retrievedAt: confirmation.retrievedAt,
            generatedAt: confirmation.upstreamRunTimeUtc,
            lastModified: confirmation.lastModified,
            etag: confirmation.etag,
            productSha256Short: confirmation.productSha256Short,
          }
        : null,
      confirmationPullFailed: confirmationFailed,
    },
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
    // What an entry has to carry when it cites a stamp. The stamp alone is not a
    // reproducible citation, so the product and the period are recorded with it.
    sourceCitation: {
      rule:
        'An entry citing a Last-Modified value records the generatedAt of the pull actually ' +
        'used and the fingerprint of the period it publishes.',
      sourceOfRecord: 'National Weather Service',
      office: NWS.office,
      grid: NWS.grid,
      endpoint: NWS.forecastUrl,
      generatedAt: nws.upstreamRunTimeUtc,
      updateTime: nws.updateTimeUtc,
      lastModified: nws.lastModified,
      etag: nws.etag,
      productSha256: nws.productSha256,
      productSha256Short: nws.productSha256Short,
      retrievedAt: nws.retrievedAt,
      publishedPeriod: nws.publishedPeriod,
      stampIdentifiesProduct: sourceIntegrity.stable,
    },
    blockers,
  };

  return artifact;
}
