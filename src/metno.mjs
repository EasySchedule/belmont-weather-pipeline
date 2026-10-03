// The second source of record: MET Norway, the Norwegian Meteorological Institute.
//
// Hard requirements enforced here, not just documented:
//   - no API key, no account, no credential of any kind;
//   - the identifying User-Agent, or MET Norway blocks the caller without warning;
//   - Celsius in, Fahrenheit out, with the conversion emitted;
//   - retrieval time per pull, plus MET Norway's own meta.updated_at;
//   - HTTP 203 is a deprecated version, not a normal answer (handled in http.mjs).

import { MET_NO, NWS, celsiusToFahrenheit, FAHRENHEIT_CONVERSION_NOTE, TIME_ZONE, userAgent } from './constants.mjs';
import { pullJson, ageMinutes } from './http.mjs';

// MET Norway symbol_code -> the coarse categories the desk compares against an
// NWS shortForecast. The mapping is deliberately coarse: BEL-33 section 5a prints
// a difference in category, so the buckets must be defensible, not clever.
// Order matters: "partlycloudy" also matches /cloudy/, and "rain"/"snow" also match
// the "light"/"heavy" prefixes, so the most specific pattern is tested first.
const SYMBOL_CATEGORY = [
  [/thunder/i, 'thunderstorm'],
  [/freezing_rain|sleet|ice_pellets|hail/i, 'wintry mix'],
  [/snow|ice|sand|dust/i, 'snow'],
  [/rain|drizzle|shower/i, 'rain'],
  [/fog|mist/i, 'fog'],
  [/partlycloudy/i, 'partly cloudy'],
  [/cloudy|overcast/i, 'cloudy'],
  [/clearsky|fair/i, 'clear'],
];

export function symbolToCategory(symbolCode) {
  if (!symbolCode) return null;
  for (const [pattern, category] of SYMBOL_CATEGORY) {
    if (pattern.test(symbolCode)) return category;
  }
  return null;
}

// NWS shortForecast -> the same coarse buckets, in the same order as the MET
// symbol buckets above so the two sources are compared like with like. "Partly"
// is tested before "cloudy" so "Partly Cloudy" is not read as overcast.
export function shortForecastToCategory(shortForecast) {
  if (!shortForecast) return null;
  const text = shortForecast.toLowerCase();
  if (/thunder/.test(text)) return 'thunderstorm';
  if (/freezing|ice|sleet|wintry/.test(text)) return 'wintry mix';
  if (/snow|flurries/.test(text)) return 'snow';
  if (/rain|shower|drizzle/.test(text)) return 'rain';
  if (/fog|mist|haze|smoke|dust/.test(text)) return 'fog';
  if (/partly/.test(text)) return 'partly cloudy';
  if (/cloudy|overcast/.test(text)) return 'cloudy';
  if (/sunny|clear/.test(text)) return 'clear';
  return null;
}

const HAZARD_SYMBOL = /thunder|fog|freezing|sleet|hail|ice_pellets/i;

export async function pullMetNo() {
  const pull = await pullJson(MET_NO.url, { label: 'MET Norway' });

  const meta = pull.body?.properties?.meta || {};
  const updatedAt = meta.updated_at;
  if (!updatedAt) {
    throw new Error('MET Norway response carried no properties.meta.updated_at');
  }
  const units = meta.units || {};
  const temperatureUnit = units.air_temperature;
  if (temperatureUnit && temperatureUnit !== 'celsius') {
    throw new Error(
      `MET Norway reported air_temperature in "${temperatureUnit}", not celsius. ` +
        'The Fahrenheit conversion assumes Celsius and must not be applied blind.',
    );
  }

  const timeseries = pull.body?.properties?.timeseries;
  if (!Array.isArray(timeseries) || timeseries.length === 0) {
    throw new Error('MET Norway returned HTTP 200 with no timeseries entries');
  }

  // Point of record check. MET Norway echoes the resolved point in geometry.
  const coordinates = pull.body?.geometry?.coordinates || null;
  const sentLatitude = NWS.point.latitude;
  const sentLongitude = NWS.point.longitude;
  const geometryMatchesPointOfRecord = coordinates
    ? Math.abs(coordinates[1] - sentLatitude) < 1e-4 && Math.abs(coordinates[0] - sentLongitude) < 1e-4
    : false;

  const hours = timeseries.map((entry) => {
    const instant = entry.data?.instant?.details || {};
    const next1 = entry.data?.next_1_hours || {};
    const next1Details = next1.details || {};
    const symbolCode = next1.summary?.symbol_code || null;
    const celsius = instant.air_temperature;
    return {
      timeUtc: entry.time,
      timeLocal: toLocalLabel(entry.time, TIME_ZONE),
      timeLocalIso: toLocalIso(entry.time, TIME_ZONE),
      celsius: typeof celsius === 'number' ? celsius : null,
      fahrenheit: typeof celsius === 'number' ? round1(celsiusToFahrenheit(celsius)) : null,
      cloudAreaFractionPercent: instant.cloud_area_fraction ?? null,
      windSpeedMs: instant.wind_speed ?? null,
      windFromDirectionDegrees: instant.wind_from_direction ?? null,
      relativeHumidityPercent: instant.relative_humidity ?? null,
      symbolCode,
      category: symbolToCategory(symbolCode),
      // MET Norway publishes a precipitation amount, not a probability. Stated
      // as-is; the pipeline never converts it into a percentage.
      precipitationAmountMm: next1Details.precipitation_amount ?? 0,
      hazard: HAZARD_SYMBOL.test(symbolCode || '') ? symbolCode : null,
    };
  });

  return {
    source: 'MET Norway',
    organisation: MET_NO.organisation,
    role: 'second independent source',
    attribution: MET_NO.attribution,
    licence: MET_NO.licence,
    endpoint: pull.endpoint,
    credentialUsed: null,
    userAgent: pull.userAgent,
    httpStatus: pull.status,
    upstreamRunTimeUtc: updatedAt,
    retrievedAt: pull.retrievedAt,
    upstreamAgeMinutes: ageMinutes(pull.retrievedAt, updatedAt),
    unitAsServed: temperatureUnit || 'celsius',
    unitAsPublished: 'fahrenheit',
    conversion: {
      formula: 'F = C x 9/5 + 32',
      note: FAHRENHEIT_CONVERSION_NOTE,
    },
    pointOfRecord: {
      sentLatitude,
      sentLongitude,
      echoedLatitude: coordinates ? coordinates[1] : null,
      echoedLongitude: coordinates ? coordinates[0] : null,
      elevationMetres: coordinates && coordinates.length > 2 ? coordinates[2] : null,
      matches: geometryMatchesPointOfRecord,
      label: NWS.point.label,
    },
    hours,
  };
}

function round1(value) {
  return Math.round(value * 10) / 10;
}

function zonedParts(utcIso, timeZone) {
  const date = new Date(utcIso);
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short',
  });
  const parts = Object.fromEntries(formatter.formatToParts(date).map((p) => [p.type, p.value]));
  const hour = parts.hour === '24' ? '00' : parts.hour;
  const offsetMinutes = offsetOf(date, timeZone);
  return { parts, hour, offsetMinutes };
}

function offsetOf(date, timeZone) {
  // -04:00 for EDT, -05:00 for EST. Derived, never assumed.
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    timeZoneName: 'longOffset',
  });
  const part = formatter.formatToParts(date).find((p) => p.type === 'timeZoneName');
  const match = part && part.value.match(/GMT([+-])(\d{2}):(\d{2})/);
  if (!match) return 0;
  const sign = match[1] === '-' ? -1 : 1;
  return sign * (Number(match[2]) * 60 + Number(match[3]));
}

function toLocalLabel(utcIso, timeZone) {
  const { parts, hour } = zonedParts(utcIso, timeZone);
  return `${parts.year}-${parts.month}-${parts.day} ${hour}:${parts.minute} ${parts.timeZoneName}`;
}

function toLocalIso(utcIso, timeZone) {
  const { parts, hour, offsetMinutes } = zonedParts(utcIso, timeZone);
  const sign = offsetMinutes < 0 ? '-' : '+';
  const abs = Math.abs(offsetMinutes);
  const off = `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
  return `${parts.year}-${parts.month}-${parts.day}T${hour}:${parts.minute}:00${off}`;
}

export { toLocalIso, toLocalLabel, offsetOf };
