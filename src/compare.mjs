// The comparison the desk gate reads, and the reconciliation line from BEL-33
// section 5a.
//
// Rules encoded here, not paraphrased in prose:
//   - the signed difference is MET Norway minus NWS, in Fahrenheit;
//   - the threshold boolean is abs(difference) <= 2 F;
//   - any difference in category, precipitation, or hazard prints at any size;
//   - the two forecasts are NEVER averaged. There is no averaging function in
//     this module and the test asserts the diff is signed, not a midpoint.

import { NWS, MET_NO, TEMPERATURE_PRINT_THRESHOLD_F } from './constants.mjs';
import { reduceMetToPeriod, windowBoundsFromNwsPeriod } from './align.mjs';

// MET Norway publishes a precipitation amount in mm, not a probability. This is
// the mm/h above which we call it precipitation for the purposes of a printed
// difference. It is a reporting rule, not a MET Norway value.
const MET_PRECIPITATION_MM_HOUR_THRESHOLD = 0.1;
const NWS_PRECIPITATION_PERCENT_THRESHOLD = 20;

const round1 = (v) => Math.round(v * 10) / 10;

export function comparePeriods(nws, met, period) {
  const bounds = windowBoundsFromNwsPeriod(period);
  const reduction = reduceMetToPeriod(met, period);

  if (!reduction) {
    return {
      period: period.name,
      window: bounds,
      comparable: false,
      reason:
        'MET Norway returned no hourly entries inside this NWS period, so there is no value to compare.',
      mustPrintDisagreement: false,
    };
  }

  const nwsFahrenheit = period.temperature;
  const metFahrenheit = reduction.fahrenheit;
  // MET Norway minus NWS. Signed. Never averaged, never blended.
  const signedDifferenceF = round1(metFahrenheit - nwsFahrenheit);
  const withinThreshold = Math.abs(signedDifferenceF) <= TEMPERATURE_PRINT_THRESHOLD_F;

  const nwsCategory = period.category;
  const metCategory = reduction.dominantCategory;
  const categoryDiffers = Boolean(nwsCategory && metCategory && nwsCategory !== metCategory);

  const nwsPrecipPercent = period.probabilityOfPrecipitationPercent;
  const metPrecipMm = reduction.totalPrecipitationMm;
  const precipitationDiffers =
    (typeof nwsPrecipPercent === 'number' && nwsPrecipPercent >= NWS_PRECIPITATION_PERCENT_THRESHOLD) !==
    (typeof metPrecipMm === 'number' && metPrecipMm >= MET_PRECIPITATION_MM_HOUR_THRESHOLD);

  const hazardDiffers = Boolean(period.hazard || reduction.hazard)
    ? hazardTokens(period.hazard).join('|') !== hazardTokens(reduction.hazard).join('|')
    : false;

  // Why this window prints, stated explicitly so the desk is never left guessing
  // about a small temperature gap that prints for another reason.
  const printReasons = [];
  if (!withinThreshold) {
    printReasons.push(
      `temperature gap ${formatSigned(signedDifferenceF)} F is above the ${TEMPERATURE_PRINT_THRESHOLD_F} F threshold`,
    );
  }
  if (categoryDiffers) {
    printReasons.push(`sky category differs: NWS ${nwsCategory}, MET Norway ${metCategory}`);
  }
  if (precipitationDiffers) {
    printReasons.push(
      `precipitation differs: NWS ${nwsPrecipPercent} percent, MET Norway ${metPrecipMm} mm`,
    );
  }
  if (hazardDiffers) {
    printReasons.push(`hazard differs: NWS ${period.hazard ?? 'none named'}, MET Norway ${reduction.hazard ?? 'none named'}`);
  }

  const mustPrintDisagreement = printReasons.length > 0;

  const comparison = {
    period: period.name,
    comparable: true,
    window: bounds,
    nws: {
      organisation: NWS.office,
      office: NWS.office,
      grid: NWS.grid,
      forecastZone: NWS.forecastZone,
      countyZone: NWS.countyZone,
      generatedAt: nws.upstreamRunTimeUtc,
      upstreamRunTimeUtc: nws.upstreamRunTimeUtc,
      retrievedAt: nws.retrievedAt,
      upstreamAgeMinutesAtRetrieval: nws.upstreamAgeMinutes,
      valueFahrenheit: nwsFahrenheit,
      shortForecast: period.shortForecast,
      category: nwsCategory,
      precipitationProbabilityPercent: nwsPrecipPercent,
      hazard: period.hazard,
    },
    metNorway: {
      organisation: MET_NO.organisation,
      attribution: MET_NO.attribution,
      licence: MET_NO.licence,
      metaUpdatedAt: met.upstreamRunTimeUtc,
      upstreamRunTimeUtc: met.upstreamRunTimeUtc,
      retrievedAt: met.retrievedAt,
      upstreamAgeMinutesAtRetrieval: met.upstreamAgeMinutes,
      unitAsServed: met.unitAsServed,
      unitAsPublished: met.unitAsPublished,
      conversion: met.conversion,
      valueFahrenheit: metFahrenheit,
      celsiusAtValue: reduction.celsiusAtExtreme,
      localTimeOfValue: reduction.localTimeOfExtreme,
      reduction: reduction.reduction,
      hoursInWindow: reduction.hoursInWindow,
      category: metCategory,
      hoursPerCategory: reduction.hoursPerCategory,
      precipitationAmountMm: metPrecipMm,
      maxCloudAreaFractionPercent: reduction.maxCloudAreaFractionPercent,
      hazard: reduction.hazard,
    },
    signedDifferenceFahrenheit: signedDifferenceF,
    signedDifferenceDefinition: 'MET Norway minus National Weather Service, in Fahrenheit',
    thresholdFahrenheit: TEMPERATURE_PRINT_THRESHOLD_F,
    withinThreshold,
    categoryDiffers,
    precipitationDiffers,
    hazardDiffers,
    mustPrintDisagreement,
    printReasons,
    metNorwaySeries: reduction.series,
  };

  if (mustPrintDisagreement) {
    comparison.reconciliation = reconciliationWording({ comparison, nws, met, period });
  }

  return comparison;
}

function hazardTokens(hazard) {
  if (!hazard) return [];
  const tokens = [];
  for (const token of hazard.toLowerCase().split(/[^a-z]+/)) {
    if (/thunder|frost|freeze|freez|flood|fog|smoke|hail|sleet|gust|wind/i.test(token)) {
      tokens.push(token);
    }
  }
  return [...new Set(tokens)];
}

// BEL-33 section 5a, verbatim in structure. Not improvised at the cut-off.
export function reconciliationWording({ comparison, nws, met, period }) {
  const subject = capitalise(period.name.toLowerCase());
  const reasons = comparison.printReasons.map((reason) => capitalise(reason));

  return (
    `The National Weather Service and MET Norway differ on ${subject}. ` +
    `The National Weather Service, ${NWS.office}, grid \`${NWS.grid}\`, gives ` +
    `${comparison.nws.valueFahrenheit} F from the ${nws.upstreamRunTimeUtc} run. ` +
    `MET Norway, retrieved ${met.retrievedAt} from its ${met.upstreamRunTimeUtc} run, gives ` +
    `${comparison.metNorway.valueFahrenheit} F. Belmont News reports the National Weather ` +
    `Service figure as the source of record and prints the difference rather than ` +
    `choosing one silently. ${reasons.join('. ')}. Both figures derive from ECMWF for this ` +
    `range, so these are two organisations reading one model family, not two independent ` +
    `views of the atmosphere.`
  );
}

function formatSigned(value) {
  return value > 0 ? `+${round1(value)}` : `${round1(value)}`;
}

function capitalise(text) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function compareAll(nws, met) {
  return nws.periods.map((period) => comparePeriods(nws, met, period));
}

// The headline line: today's daytime period, which is the window the 5a worked
// example and this issue both talk about.
export function headlineComparison(comparisons) {
  return comparisons.find((c) => c.comparable && c.window.kind === 'day') || comparisons[0] || null;
}

export { MET_PRECIPITATION_MM_HOUR_THRESHOLD, NWS_PRECIPITATION_PERCENT_THRESHOLD };
