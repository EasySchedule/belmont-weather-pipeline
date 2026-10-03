// Fixed identifiers of record. Nothing here may be inferred at runtime.
//
// Canonical sources for these values:
//   BEL-17 section 2 (editorial-standard)
//   BEL-22 section 7 (publishing-calendar)
//   BEL-33 section 5a (notion-editorial-standard)
//   BEL-75 weather-second-source-decision

export const NEWSROOM = 'Belmont News';

// Base URLs are resolved at call time, not at module load, so a test can point
// them at a local stub without an import-order race. The defaults are the only
// values used in a production run.
export const nwsBaseUrl = () => process.env.BELMONT_NWS_BASE_URL || 'https://api.weather.gov';
export const metNoBaseUrl = () => process.env.BELMONT_MET_NO_BASE_URL || 'https://api.met.no';
export const userAgent = () =>
  process.env.BELMONT_USER_AGENT ||
  'BelmontNews/1.0 (https://belmont-news.example; m.vance@agentmail.to)';

// Source of record, first: the National Weather Service public API.
export const NWS = {
  organisation: 'National Weather Service',
  office: 'NWS Pittsburgh',
  host: 'https://api.weather.gov',
  point: { latitude: 40.1006, longitude: -80.8501, label: 'St. Clairsville, Ohio' },
  gridId: 'PBZ',
  gridX: 50,
  gridY: 48,
  grid: 'PBZ/50,48',
  forecastZone: 'OHZ059',
  countyZone: 'OHC013',
  get forecastUrl() {
    return `${nwsBaseUrl()}/gridpoints/${this.gridId}/${this.gridX},${this.gridY}/forecast`;
  },
};

// Second independent source: MET Norway, the Norwegian Meteorological Institute.
// A different organisation from NOAA, and it does not consume api.weather.gov.
export const MET_NO = {
  organisation: 'The Norwegian Meteorological Institute',
  shortOrganisation: 'MET Norway',
  attribution: 'Based on data from MET Norway',
  licence: 'NLOD 2.0 / CC BY 4.0',
  path: '/weatherapi/locationforecast/2.0/compact',
  // No API key. No account. No cost. Any credential in this implementation is a defect.
  requiresCredential: false,
  get url() {
    const { latitude, longitude } = NWS.point;
    return `${metNoBaseUrl()}${this.path}?lat=${latitude}&lon=${longitude}`;
  },
};

// Both pulls reuse the same identifying User-Agent pattern. MET Norway blocks a
// caller that does not name the newsroom and give a contact address.
export const USER_AGENT = userAgent();

export const TIME_ZONE = 'America/New_York';

// BEL-33 section 5a: a temperature difference of 2 F or less is not printed.
// A difference in category, precipitation, or a hazard is printed at any size.
export const TEMPERATURE_PRINT_THRESHOLD_F = 2.0;

// BEL-17 section 2: the newsroom prints Fahrenheit; MET Norway returns Celsius.
export const celsiusToFahrenheit = (c) => (c * 9) / 5 + 32;
export const FAHRENHEIT_CONVERSION_NOTE =
  'MET Norway returns air_temperature in Celsius; converted to Fahrenheit as F = C x 9/5 + 32.';
