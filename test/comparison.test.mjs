// The comparison contract: signed difference, the 2 F threshold boolean, the
// conversion, the alignment, and the rule that the two forecasts are never
// averaged.

import test from 'node:test';
import assert from 'node:assert/strict';

import { startStub, metFixtureBody } from './stub.mjs';
import { celsiusToFahrenheit, TEMPERATURE_PRINT_THRESHOLD_F, MET_NO } from '../src/constants.mjs';
import { comparePeriods, headlineComparison, compareAll } from '../src/compare.mjs';
import { reduceMetToPeriod, metHoursInWindow } from '../src/align.mjs';
import { symbolToCategory, shortForecastToCategory } from '../src/metno.mjs';

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

async function load() {
  const { pullNws } = await import('../src/nws.mjs');
  const { pullMetNo } = await import('../src/metno.mjs');
  return { nws: await pullNws(), met: await pullMetNo() };
}

test('both sources are pulled, each with its own upstream run time and its own retrieval time', async () => {
  await withStub({ metNoBehaviour: 'ok' }, async () => {
    const { nws, met } = await load();

    assert.equal(nws.office, 'NWS Pittsburgh');
    assert.equal(nws.grid, 'PBZ/50,48');
    assert.equal(nws.forecastZone, 'OHZ059');
    assert.equal(nws.countyZone, 'OHC013');
    assert.equal(nws.upstreamRunTimeUtc, '2026-10-02T23:17:15+00:00');
    assert.ok(nws.retrievedAt);

    assert.equal(met.upstreamRunTimeUtc, '2026-10-02T23:20:06Z');
    assert.ok(met.retrievedAt);
    assert.ok(typeof nws.upstreamAgeMinutes === 'number');
    assert.ok(typeof met.upstreamAgeMinutes === 'number');

    // No credential of any kind is used on either pull.
    assert.equal(met.credentialUsed, null);
    assert.equal(MET_NO.requiresCredential, false);
    assert.equal(new URL(met.endpoint).searchParams.has('token'), false);
  });
});

test('MET Norway emits Fahrenheit with the conversion stated, never a bare Celsius number', async () => {
  await withStub({ metNoBehaviour: 'ok' }, async () => {
    const { met } = await load();
    assert.equal(met.unitAsServed, 'celsius');
    assert.equal(met.unitAsPublished, 'fahrenheit');
    assert.equal(met.conversion.formula, 'F = C x 9/5 + 32');
    assert.match(met.conversion.note, /Celsius/);
    for (const hour of met.hours) {
      assert.equal(hour.fahrenheit, Math.round(celsiusToFahrenheit(hour.celsius) * 10) / 10);
    }
  });
});

test('the MET Norway pull echoes the point of record and it is checked', async () => {
  await withStub({ metNoBehaviour: 'ok' }, async () => {
    const { met } = await load();
    assert.equal(met.pointOfRecord.sentLatitude, 40.1006);
    assert.equal(met.pointOfRecord.sentLongitude, -80.8501);
    assert.equal(met.pointOfRecord.echoedLatitude, 40.1006);
    assert.equal(met.pointOfRecord.echoedLongitude, -80.8501);
    assert.equal(met.pointOfRecord.matches, true);
    assert.equal(met.pointOfRecord.label, 'St. Clairsville, Ohio');
  });
});

test('a silently different point does not pass the point-of-record check', async () => {
  const body = metFixtureBody();
  body.geometry.coordinates = [-79.0, 41.5, 300];
  await withStub({ metNoBehaviour: 'ok', metBody: body }, async () => {
    const { pullMetNo } = await import('../src/metno.mjs');
    const met = await pullMetNo();
    assert.equal(met.pointOfRecord.matches, false);
    assert.equal(met.pointOfRecord.echoedLatitude, 41.5);
  });
});

test('the MET Norway hourly series is converted to America/New_York and reduced over the NWS window', async () => {
  await withStub({ metNoBehaviour: 'ok' }, async () => {
    const { nws, met } = await load();
    const saturday = nws.periods.find((p) => p.name === 'Saturday');
    const hours = metHoursInWindow(met, saturday);
    assert.equal(hours.length, 4, '06:00, 09:00, 12:00 and 15:00 EDT fall inside the window');
    assert.equal(hours[0].timeLocal, '2026-10-03 06:00 EDT');
    assert.equal(hours[0].timeLocalIso, '2026-10-03T06:00:00-04:00');
    assert.equal(hours[3].timeLocal, '2026-10-03 15:00 EDT');

    const reduction = reduceMetToPeriod(met, saturday);
    // Max over a daytime window, not a raw instant.
    assert.match(reduction.reduction, /max of hourly air_temperature/);
    assert.equal(reduction.fahrenheit, 66.6);
    assert.equal(reduction.celsiusAtExtreme, 19.2);
    // The peak in this fixture is the 12:00 EDT entry, 19.2 C -> 66.6 F.
    assert.equal(reduction.localTimeOfExtremeIso, '2026-10-03T12:00:00-04:00');
    assert.equal(reduction.hoursInWindow, 4);
  });
});

test('a night window reduces to the minimum, not the maximum', async () => {
  await withStub({ metNoBehaviour: 'ok' }, async () => {
    const { nws, met } = await load();
    const night = nws.periods.find((p) => p.name === 'Saturday Night');
    const reduction = reduceMetToPeriod(met, night);
    assert.match(reduction.reduction, /min of hourly air_temperature/);
    // The only night-window entry is 2026-10-04T01:00:00Z = 21:00 EDT, 11.2 C.
    assert.equal(reduction.fahrenheit, 52.2);
    assert.equal(reduction.localTimeOfExtremeIso, '2026-10-03T21:00:00-04:00');
  });
});

test('an NWS period is never compared against a raw MET Norway instant', async () => {
  await withStub({ metNoBehaviour: 'ok' }, async () => {
    const { nws, met } = await load();
    const saturday = nws.periods.find((p) => p.name === 'Saturday');
    const rawInstants = met.hours
      .filter((h) => h.timeLocalIso >= saturday.startTime && h.timeLocalIso < saturday.endTime)
      .map((h) => h.fahrenheit);
    const comparison = comparePeriods(nws, met, saturday);
    assert.ok(rawInstants.length > 1, 'more than one instant is inside the window');
    assert.notEqual(comparison.metNorway.valueFahrenheit, rawInstants[0]);
    assert.equal(comparison.metNorway.reduction, 'max of hourly air_temperature over the daytime window');
  });
});

test('the signed difference is MET Norway minus NWS and is not an average', async () => {
  await withStub({ metNoBehaviour: 'ok' }, async () => {
    const { nws, met } = await load();
    const saturday = nws.periods.find((p) => p.name === 'Saturday');
    const comparison = comparePeriods(nws, met, saturday);

    // Fixture: NWS 69 F, MET max 66.6 F. Difference -2.4 F.
    assert.equal(comparison.nws.valueFahrenheit, 69);
    assert.equal(comparison.metNorway.valueFahrenheit, 66.6);
    assert.equal(comparison.signedDifferenceFahrenheit, -2.4);
    assert.equal(comparison.signedDifferenceDefinition, 'MET Norway minus National Weather Service, in Fahrenheit');

    const midpoint = (69 + 66.6) / 2;
    assert.notEqual(comparison.signedDifferenceFahrenheit, midpoint);
    assert.ok(comparison.nws.valueFahrenheit > comparison.metNorway.valueFahrenheit);
    assert.ok(comparison.signedDifferenceFahrenheit < 0, 'a cooler MET Norway reads negative');

    // There is no averaging anywhere in the emitted artifact.
    const json = JSON.stringify(comparison);
    assert.equal(/averag/i.test(json), false);
    assert.equal(/mean of|midpoint/i.test(json), false);
  });
});

test('the 2 F threshold boolean behaves at the boundary', async () => {
  await withStub({ metNoBehaviour: 'ok' }, async () => {
    const { nws, met } = await load();
    const saturday = nws.periods.find((p) => p.name === 'Saturday');
    const comparison = comparePeriods(nws, met, saturday);

    assert.equal(comparison.thresholdFahrenheit, TEMPERATURE_PRINT_THRESHOLD_F);
    assert.equal(comparison.withinThreshold, false, '2.4 F is above the threshold');
    assert.equal(comparison.mustPrintDisagreement, true);
  });

  // Exactly 2 F is not printed; 2.1 F is.
  const cases = [
    { diff: 2.0, expected: true },
    { diff: -2.0, expected: true },
    { diff: 2.1, expected: false },
    { diff: -2.4, expected: false },
    { diff: 0, expected: true },
  ];
  for (const { diff, expected } of cases) {
    const within = Math.abs(diff) <= TEMPERATURE_PRINT_THRESHOLD_F;
    assert.equal(within, expected, `diff ${diff}`);
  }
});

test('a disagreement above 2 F prints the BEL-33 section 5a wording with both organisations and both run times', async () => {
  await withStub({ metNoBehaviour: 'ok' }, async () => {
    const { nws, met } = await load();
    const saturday = nws.periods.find((p) => p.name === 'Saturday');
    const comparison = comparePeriods(nws, met, saturday);
    const wording = comparison.reconciliation;

    assert.match(wording, /The National Weather Service and MET Norway differ on Saturday\./);
    assert.match(wording, /NWS Pittsburgh, grid `PBZ\/50,48`, gives 69 F from the 2026-10-02T23:17:15\+00:00 run\./);
    assert.match(wording, /MET Norway, retrieved \S+ from its 2026-10-02T23:20:06Z run, gives 66\.6 F\./);
    assert.match(wording, /Belmont News reports the National Weather Service figure as the source of record/);
    assert.match(wording, /choosing one silently/);
    assert.match(wording, /ECMWF/);
    assert.ok(!/average/i.test(wording));
  });
});

test('a difference in category prints at any size', async () => {
  const body = metFixtureBody();
  // Flat MET temperatures that land on the same 69 F as NWS after conversion, so
  // the temperature check is quiet and the category and precipitation checks are
  // the only triggers. 20.5 C is 68.9 F.
  body.properties.timeseries = body.properties.timeseries.map((entry) => ({
    ...entry,
    data: {
      ...entry.data,
      instant: { details: { ...entry.data.instant.details, air_temperature: 20.5 } },
      next_1_hours: { summary: { symbol_code: 'heavyrain' }, details: { precipitation_amount: 2.5 } },
    },
  }));
  await withStub({ metNoBehaviour: 'ok', metBody: body }, async () => {
    const { nws, met } = await load();
    const saturday = nws.periods.find((p) => p.name === 'Saturday');
    const comparison = comparePeriods(nws, met, saturday);
    assert.equal(comparison.metNorway.valueFahrenheit, 68.9);
    assert.equal(comparison.signedDifferenceFahrenheit, -0.1, 'temperature effectively agrees');
    assert.equal(comparison.withinThreshold, true);
    assert.equal(comparison.nws.category, 'clear');
    assert.equal(comparison.metNorway.category, 'rain');
    assert.equal(comparison.categoryDiffers, true, 'clear against rain prints at any size');
    assert.equal(comparison.precipitationDiffers, true, '0 percent against 10 mm prints too');
    assert.equal(comparison.mustPrintDisagreement, true);
    assert.match(comparison.reconciliation, /Sky category differs/);
  });
});

test('category bucketing is coarse and shared between the two sources', () => {
  assert.equal(symbolToCategory('clearsky_day'), 'clear');
  assert.equal(symbolToCategory('partlycloudy_day'), 'partly cloudy');
  assert.equal(symbolToCategory('cloudy'), 'cloudy');
  assert.equal(symbolToCategory('lightrain'), 'rain');
  assert.equal(symbolToCategory('heavyrain_and_thunder'), 'thunderstorm');
  assert.equal(symbolToCategory('lightsnow'), 'snow');
  assert.equal(symbolToCategory('fog'), 'fog');
  assert.equal(shortForecastToCategory('Sunny'), 'clear');
  assert.equal(shortForecastToCategory('Partly Cloudy'), 'partly cloudy');
    assert.equal(shortForecastToCategory('Slight Chance Rain Showers'), 'rain');
  assert.equal(shortForecastToCategory('Scattered Thunderstorms'), 'thunderstorm');
  assert.equal(shortForecastToCategory('Snow Showers'), 'snow');
});

test('the headline comparison is the first daytime period', async () => {
  await withStub({ metNoBehaviour: 'ok' }, async () => {
    const { nws, met } = await load();
    const comparisons = compareAll(nws, met);
    const headline = headlineComparison(comparisons);
    assert.equal(headline.period, 'Saturday');
    assert.equal(headline.window.kind, 'day');
    assert.equal(headline.window.startLocalIso, '2026-10-03T06:00:00-04:00');
    assert.equal(headline.window.endLocalIso, '2026-10-03T18:00:00-04:00');
  });
});

test('the attribution credits MET Norway as a source and never as the publisher', async () => {
  await withStub({ metNoBehaviour: 'ok' }, async () => {
    const { runRoundup } = await import('../src/roundup.mjs');
    const artifact = await runRoundup({ edition: 'morning' });
    assert.equal(artifact.sourceCount, 2);
    assert.match(artifact.attribution.second, /Based on data from MET Norway/);
    assert.match(artifact.attribution.second, /The Norwegian Meteorological Institute/);
    assert.match(artifact.attribution.second, /NLOD 2\.0 \/ CC BY 4\.0/);
    assert.match(artifact.attribution.publisher, /Belmont News publishes this item/);
    assert.equal(/published by MET Norway/i.test(JSON.stringify(artifact)), false);
    assert.equal(artifact.credentialUsed, null);
  });
});
test('every printed disagreement says why it prints', async () => {
  await withStub({ metNoBehaviour: 'ok' }, async () => {
    const { nws, met } = await load();
    const comparisons = compareAll(nws, met);
    for (const comparison of comparisons) {
      assert.ok(Array.isArray(comparison.printReasons));
      assert.equal(
        comparison.mustPrintDisagreement,
        comparison.printReasons.length > 0,
        `${comparison.period}: mustPrint and printReasons disagree`,
      );
      if (comparison.mustPrintDisagreement) {
        assert.ok(comparison.reconciliation, `${comparison.period} prints without wording`);
        assert.match(comparison.reconciliation, /\.$/);
        assert.equal(/\b\w/.test(comparison.reconciliation.split('. ')[1] || '') && /^[a-z]/.test(comparison.reconciliation.split('. ')[1] || ''), false, 'sentences are capitalised');
      } else {
        assert.equal(comparison.reconciliation, undefined);
      }
    }
  });
});

test('a small temperature gap still prints when the category differs, and says so', async () => {
  await withStub({ metNoBehaviour: 'ok' }, async () => {
    const { nws, met } = await load();
    // The Saturday Night fixture: 53 F against 52.2 F, inside the 2 F threshold.
    const night = nws.periods.find((p) => p.name === 'Saturday Night');
    const comparison = comparePeriods(nws, met, night);
    assert.equal(comparison.signedDifferenceFahrenheit, -0.8);
    assert.equal(comparison.withinThreshold, true);
    assert.equal(comparison.nws.category, 'partly cloudy');
    assert.equal(comparison.metNorway.category, 'clear');
    assert.equal(comparison.categoryDiffers, true);
    assert.equal(comparison.mustPrintDisagreement, true);
    assert.equal(comparison.printReasons.length, 1);
    assert.match(comparison.printReasons[0], /sky category differs/);
  });
});
