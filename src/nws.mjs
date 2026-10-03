// Source of record, first: the National Weather Service public API.

import { NWS, TIME_ZONE } from './constants.mjs';
import { pullJson, ageMinutes } from './http.mjs';
import { shortForecastToCategory } from './metno.mjs';

const HAZARD_FORECAST = /thunder|frost|freeze|freezing|wind chill|heat index|windy|gust|severe|flood|fog|smoke|hail|sleet/i;

export async function pullNws() {
  const pull = await pullJson(NWS.forecastUrl, { label: 'NWS' });

  const properties = pull.body?.properties || {};
  const generatedAt = properties.generatedAt;
  if (!generatedAt) {
    throw new Error('NWS response carried no properties.generatedAt');
  }
  const periods = properties.periods;
  if (!Array.isArray(periods) || periods.length === 0) {
    throw new Error('NWS returned HTTP 200 with no periods');
  }

  const shaped = periods.map((period) => ({
    number: period.number,
    name: period.name,
    startTime: period.startTime,
    endTime: period.endTime,
    startLocal: period.startTime,
    endLocal: period.endTime,
    temperature: period.temperature,
    temperatureUnit: period.temperatureUnit,
    shortForecast: period.shortForecast,
    category: shortForecastToCategory(period.shortForecast),
    probabilityOfPrecipitationPercent: period.probabilityOfPrecipitation?.value ?? null,
    windSpeed: period.windSpeed,
    windDirection: period.windDirection,
    isDaytime: Boolean(period.isDaytime),
    hazard: HAZARD_FORECAST.test(period.shortForecast || '') ? period.shortForecast : null,
  }));

  return {
    source: 'National Weather Service',
    organisation: NWS.office,
    role: 'source of record',
    endpoint: pull.endpoint,
    httpStatus: pull.status,
    office: NWS.office,
    grid: NWS.grid,
    gridId: NWS.gridId,
    gridX: NWS.gridX,
    gridY: NWS.gridY,
    forecastZone: NWS.forecastZone,
    countyZone: NWS.countyZone,
    countyName: 'Belmont County, Ohio',
    pointOfRecord: {
      sentLatitude: NWS.point.latitude,
      sentLongitude: NWS.point.longitude,
      label: NWS.point.label,
    },
    upstreamRunTimeUtc: generatedAt,
    updateTimeUtc: properties.updateTime || null,
    validTimes: properties.validTimes || null,
    retrievedAt: pull.retrievedAt,
    upstreamAgeMinutes: ageMinutes(pull.retrievedAt, generatedAt),
    unitAsPublished: shaped[0]?.temperatureUnit || 'F',
    periods: shaped,
    timeZone: TIME_ZONE,
  };
}

// The period whose own local start/end times contain the requested instant.
export function periodCovering(nws, instantIso) {
  const instant = Date.parse(instantIso);
  return (
    nws.periods.find((period) => {
      const start = Date.parse(period.startTime);
      const end = Date.parse(period.endTime);
      return instant >= start && instant < end;
    }) || null
  );
}
