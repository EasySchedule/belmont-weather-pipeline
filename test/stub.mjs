// A local stub of api.weather.gov and api.met.no, so the failure path can be
// exercised for real: real HTTP, real status codes, real pipeline code. No
// network egress is used by these tests and no source is mocked inside the
// pipeline itself.

import { createServer } from 'node:http';

export const NWS_FIXTURE_PERIODS = [
  {
    number: 1,
    name: 'Saturday',
    startTime: '2026-10-03T06:00:00-04:00',
    endTime: '2026-10-03T18:00:00-04:00',
    isDaytime: true,
    temperature: 69,
    temperatureUnit: 'F',
    shortForecast: 'Sunny',
    probabilityOfPrecipitation: { unitCode: 'wmoUnit:percent', value: 0 },
    windSpeed: '6 to 9 mph',
    windDirection: 'NE',
  },
  {
    number: 2,
    name: 'Saturday Night',
    startTime: '2026-10-03T18:00:00-04:00',
    endTime: '2026-10-04T06:00:00-04:00',
    isDaytime: false,
    temperature: 53,
    temperatureUnit: 'F',
    shortForecast: 'Partly Cloudy',
    probabilityOfPrecipitation: { unitCode: 'wmoUnit:percent', value: 0 },
    windSpeed: '1 to 6 mph',
    windDirection: 'NE',
  },
];

export const NWS_FIXTURE_BODY = {
  properties: {
    generatedAt: '2026-10-02T23:17:15+00:00',
    updateTime: '2026-10-02T22:41:36+00:00',
    validTimes: '2026-10-02T12:00:00+00:00/P7DT13H',
    periods: NWS_FIXTURE_PERIODS,
  },
};

export function metFixtureBody({ updatedAt = '2026-10-02T23:20:06Z' } = {}) {
  // Hourly entries at 06:00, 09:00, 12:00, 15:00 EDT on 2026-10-03, i.e. inside
  // the Saturday 06:00-18:00 EDT window, plus one in the night window.
  const entries = [
    ['2026-10-03T10:00:00Z', 14.2, 0],
    ['2026-10-03T13:00:00Z', 16.2, 0],
    ['2026-10-03T16:00:00Z', 19.2, 0],
    ['2026-10-03T19:00:00Z', 18.5, 0],
    ['2026-10-04T01:00:00Z', 11.2, 0],
  ];
  return {
    geometry: { type: 'Point', coordinates: [-80.8501, 40.1006, 252] },
    properties: {
      meta: {
        updated_at: updatedAt,
        units: {
          air_pressure_at_sea_level: 'hPa',
          air_temperature: 'celsius',
          cloud_area_fraction: '%',
          precipitation_amount: 'mm',
          relative_humidity: '%',
          wind_from_direction: 'degrees',
          wind_speed: 'm/s',
        },
      },
      timeseries: entries.map(([time, air_temperature, cloud_area_fraction]) => ({
        time,
        data: {
          instant: { details: { air_temperature, cloud_area_fraction, relative_humidity: 60, wind_speed: 3, wind_from_direction: 10 } },
          next_1_hours: {
            summary: { symbol_code: 'clearsky_day' },
            details: { precipitation_amount: 0 },
          },
        },
      })),
    },
  };
}

// The one stamp both NWS bodies are served under, as api.weather.gov served them
// on 2026-10-03 under BEL-91.
export const NWS_FIXTURE_LAST_MODIFIED = 'Fri, 02 Oct 2026 22:41:34 GMT';
export const NWS_FIXTURE_ETAG = 'W/"1790980896:dtagent10337260504112723F6xZ"';

// The second body BEL-91 recorded under that same stamp: identical in every field
// except period 1, which reads 17 percent instead of 3 and carries a later
// startTime and a different narrative. Periods 2..14 were identical field for
// field, so the fixture changes period 1 only.
export const NWS_FIXTURE_ALTERNATE_BODY = {
  properties: {
    generatedAt: '2026-10-03T00:19:57+00:00',
    updateTime: '2026-10-02T22:41:36+00:00',
    validTimes: '2026-10-02T16:00:00+00:00/P7DT9H',
    periods: [
      {
        ...NWS_FIXTURE_PERIODS[0],
        startTime: '2026-10-02T20:00:00-04:00',
        shortForecast: 'Mostly Cloudy',
        detailedForecast: 'Mostly cloudy, with a low around 48. North wind around 7 mph.',
        probabilityOfPrecipitation: { unitCode: 'wmoUnit:percent', value: 3 },
      },
      NWS_FIXTURE_PERIODS[1],
    ],
  },
};

// metNoBehaviour: 'ok' | 'http-503' | 'http-203' | 'empty-200' | 'connection-refused'
// nwsBehaviour:
//   'ok'                      one body, stamped, with the negotiated type echoed
//   'two-bodies-one-stamp'    two bodies, one Last-Modified, one ETag, alternating
//   'no-last-modified'        one body, no stamp at all
//   'per-representation'      two bodies chosen by the Accept header, one stamp
export async function startStub({
  metNoBehaviour = 'ok',
  metBody = null,
  metStatus = null,
  nwsBehaviour = 'ok',
} = {}) {
  const requests = [];
  let nwsPulls = 0;
  const server = createServer((req, res) => {
    requests.push({
      url: req.url,
      userAgent: req.headers['user-agent'] || null,
      accept: req.headers.accept || null,
    });
    const send = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(typeof body === 'string' ? body : JSON.stringify(body));
    };

    if (req.url.startsWith('/gridpoints/')) {
      // Both NWS bodies carry the same stamp and the same ETag. That is the
      // defect BEL-91 recorded, reproduced over real HTTP against the real
      // pipeline: nothing in the response identifies which product was served.
      const headers =
        nwsBehaviour === 'no-last-modified'
          ? {}
          : {
              'Last-Modified': NWS_FIXTURE_LAST_MODIFIED,
              ETag: NWS_FIXTURE_ETAG,
              'Cache-Control': 'public, max-age=1401, s-maxage=3600',
            };
      // The order is the one BEL-91 recorded: the 00:19:57 generation was served
      // first and the 23:17:15 generation came back on a later pull under the same
      // stamp, so generatedAt moves backwards between two pulls of one URL.
      // BEL-94: the endpoint picks the body by negotiated media type and stamps
      // every representation identically. Reproduced here so the pipeline has to
      // record which representation it asked for.
      const accept = req.headers.accept || '';
      const wantsGeoJson = accept.includes('application/geo+json');
      let body = NWS_FIXTURE_BODY;
      if (nwsBehaviour === 'per-representation') {
        body = wantsGeoJson ? NWS_FIXTURE_ALTERNATE_BODY : NWS_FIXTURE_BODY;
      } else if (nwsBehaviour === 'two-bodies-one-stamp' && nwsPulls % 2 === 0) {
        body = NWS_FIXTURE_ALTERNATE_BODY;
      }
      nwsPulls += 1;
      res.writeHead(200, {
        'Content-Type': wantsGeoJson ? 'application/geo+json; charset=utf-8' : 'application/json',
        Vary: 'Accept,Feature-Flags,Accept-Language',
        ...headers,
      });
      return res.end(JSON.stringify(body));
    }

    if (req.url.includes('locationforecast')) {
      switch (metNoBehaviour) {
        case 'ok':
          return send(200, metBody || metFixtureBody());
        case 'http-503':
          return send(metStatus || 503, { error: 'Service Unavailable' });
        case 'http-203':
          return send(203, metBody || metFixtureBody());
        case 'http-403':
          return send(403, { error: 'Forbidden' });
        case 'empty-200':
          return send(200, {});
        case 'no-timeseries':
          return send(200, { geometry: { type: 'Point', coordinates: [-80.8501, 40.1006] }, properties: { meta: { updated_at: '2026-10-02T23:20:06Z', units: { air_temperature: 'celsius' } }, timeseries: [] } });
        default:
          return send(500, { error: 'unsupported stub behaviour' });
      }
    }
    return send(404, { error: 'not found' });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
