// Window alignment.
//
// NWS returns day and night periods with local start and end times.
// MET Norway returns an hourly series in UTC.
// An NWS period value is never compared against a raw MET Norway instant: the
// MET series is converted to America/New_York first, then reduced over the
// window the NWS period covers - max over a daytime window, min over a night one.

import { TIME_ZONE } from './constants.mjs';
import { offsetOf, toLocalIso, toLocalLabel } from './metno.mjs';

export function windowBoundsFromNwsPeriod(period) {
  const start = new Date(period.startTime);
  const end = new Date(period.endTime);
  return {
    startUtc: start.toISOString(),
    endUtc: end.toISOString(),
    startLocalIso: toLocalIso(start.toISOString(), TIME_ZONE),
    endLocalIso: toLocalIso(end.toISOString(), TIME_ZONE),
    startLocalLabel: toLocalLabel(start.toISOString(), TIME_ZONE),
    endLocalLabel: toLocalLabel(end.toISOString(), TIME_ZONE),
    offsetMinutes: offsetOf(start, TIME_ZONE),
    kind: period.isDaytime ? 'day' : 'night',
  };
}

// MET Norway hours inside the window, half-open on [start, end) so an instant is
// never counted in two adjacent periods.
export function metHoursInWindow(met, period) {
  const start = Date.parse(period.startTime);
  const end = Date.parse(period.endTime);
  return met.hours.filter((hour) => {
    const t = Date.parse(hour.timeUtc);
    return t >= start && t < end;
  });
}

// Reduce the MET Norway hourly series over one NWS period:
//   daytime window -> max air temperature, which is the comparable of an NWS
//                     daytime period value;
//   night window   -> min air temperature, comparable of an NWS night value.
export function reduceMetToPeriod(met, period) {
  const hours = metHoursInWindow(met, period);
  if (hours.length === 0) return null;

  const temperatures = hours.map((h) => h.fahrenheit).filter((v) => typeof v === 'number');
  if (temperatures.length === 0) return null;

  const isDay = Boolean(period.isDaytime);
  const extreme = isDay
    ? temperatures.reduce((a, b) => (b > a ? b : a))
    : temperatures.reduce((a, b) => (b < a ? b : a));
  const extremeHour = hours.find((h) => h.fahrenheit === extreme) || null;

  const clouds = hours.map((h) => h.cloudAreaFractionPercent).filter((v) => typeof v === 'number');
  const precip = hours.map((h) => h.precipitationAmountMm).filter((v) => typeof v === 'number');
  const categories = hours.map((h) => h.category).filter(Boolean);
  const hazards = hours.map((h) => h.hazard).filter(Boolean);

  // Dominant category: the bucket covering the most hours in the window.
  const tally = new Map();
  for (const category of categories) tally.set(category, (tally.get(category) || 0) + 1);
  let dominantCategory = null;
  let dominantCount = -1;
  for (const [category, count] of tally) {
    if (count > dominantCount) {
      dominantCategory = category;
      dominantCount = count;
    }
  }

  return {
    reduction: isDay ? 'max of hourly air_temperature over the daytime window' : 'min of hourly air_temperature over the night window',
    hoursInWindow: hours.length,
    fahrenheit: extreme,
    fahrenheitRounded: Math.round(extreme * 10) / 10,
    celsiusAtExtreme: extremeHour ? extremeHour.celsius : null,
    localTimeOfExtreme: extremeHour ? extremeHour.timeLocal : null,
    localTimeOfExtremeIso: extremeHour ? extremeHour.timeLocalIso : null,
    maxCloudAreaFractionPercent: clouds.length ? Math.max(...clouds) : null,
    totalPrecipitationMm: precip.length
      ? Math.round(precip.reduce((a, b) => a + b, 0) * 1000) / 1000
      : 0,
    dominantCategory,
    hoursPerCategory: Object.fromEntries(tally),
    hazard: hazards.length ? hazards[0] : null,
    symbols: [...new Set(hours.map((h) => h.symbolCode).filter(Boolean))],
    series: hours.map((h) => ({
      local: h.timeLocal,
      localIso: h.timeLocalIso,
      celsius: h.celsius,
      fahrenheit: h.fahrenheit,
      cloudPercent: h.cloudAreaFractionPercent,
      symbol: h.symbolCode,
      precipitationMm: h.precipitationAmountMm,
    })),
  };
}
