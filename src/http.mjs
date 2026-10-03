// One HTTP pull, with the retrieval time of that pull captured at the moment of
// the fetch. A timestamp computed at build time is a defect (BEL-17 section 2),
// so retrievedAt is taken here, inside the request, and never passed in.

import { userAgent } from './constants.mjs';

// The response headers that decide which product a pull was served, and that a
// later pull has to be compared against. Before BEL-91 the pipeline recorded the
// body of a pull but not the stamp that named it, so a weather item could cite a
// `Last-Modified` value the pipeline had never captured and nobody could tell two
// products apart. Only headers a reader can act on are kept; the rest of the
// response head is not provenance.
const PROVENANCE_HEADERS = [
  'last-modified',
  'etag',
  'date',
  'age',
  'cache-control',
  'expires',
  'x-request-id',
  'x-correlation-id',
  'x-server-id',
  'x-edge-request-id',
  'server-timing',
];

// A pull that carries no `Last-Modified` at all is not silently treated as if it
// carried a fresh one. `null` means the header was absent, which is a different
// fact from a value, and BEL-17 section 2 requires the two not be conflated.
function captureHeaders(response) {
  const captured = {};
  for (const name of PROVENANCE_HEADERS) {
    const value = response.headers.get(name);
    if (value !== null && value !== undefined) captured[name] = value;
  }
  return captured;
}

export class PullFailure extends Error {
  constructor(message, { endpoint, status, retrievedAt, bodyHead, deprecated, userAgent }) {
    super(message);
    this.name = 'PullFailure';
    this.endpoint = endpoint;
    this.status = status;
    this.retrievedAt = retrievedAt;
    this.bodyHead = bodyHead;
    this.userAgent = userAgent;
    // HTTP 203 from MET Norway means a deprecated version, not a normal answer.
    this.deprecated = Boolean(deprecated);
  }
}

export async function pullJson(endpoint, { label }) {
  // The retrieval time of THIS fetch. Recorded before the request goes out and
  // refined after it lands, so the printed value brackets the actual transfer.
  const requestedAt = new Date();
  const sentUserAgent = userAgent();
  let response;
  try {
    response = await fetch(endpoint, {
      headers: { 'User-Agent': sentUserAgent, Accept: 'application/json' },
      redirect: 'follow',
    });
  } catch (cause) {
    const retrievedAt = new Date();
    throw new PullFailure(`${label} pull failed: ${cause.message}`, {
      endpoint,
      status: null,
      retrievedAt: retrievedAt.toISOString(),
      userAgent: sentUserAgent,
    });
  }
  const retrievedAt = new Date();
  const text = await response.text();

  if (response.status === 203) {
    // Do not treat 203 as success. Log it and surface it (BEL-17 section 2).
    console.error(
      `[${label}] HTTP 203 from ${endpoint}: deprecated API version. ` +
        'This is not a normal answer and is not used as data.',
    );
    throw new PullFailure(
      `${label} answered HTTP 203: deprecated API version, not a normal answer`,
      { endpoint, status: 203, retrievedAt: retrievedAt.toISOString(), deprecated: true, bodyHead: text.slice(0, 200) },
    );
  }

  if (!response.ok) {
    throw new PullFailure(`${label} answered HTTP ${response.status}`, {
      endpoint,
      status: response.status,
      retrievedAt: retrievedAt.toISOString(),
      userAgent: sentUserAgent,
      bodyHead: text.slice(0, 200),
    });
  }

  let body;
  try {
    body = JSON.parse(text);
  } catch (cause) {
    throw new PullFailure(`${label} returned a body that is not JSON: ${cause.message}`, {
      endpoint,
      status: response.status,
      retrievedAt: retrievedAt.toISOString(),
      userAgent: sentUserAgent,
      bodyHead: text.slice(0, 200),
    });
  }

  // A 200 with an empty or unusable body is a failed pull, not a successful one.
  if (!body || typeof body !== 'object' || Object.keys(body).length === 0) {
    throw new PullFailure(`${label} returned HTTP 200 with an empty body`, {
      endpoint,
      status: response.status,
      retrievedAt: retrievedAt.toISOString(),
      userAgent: sentUserAgent,
    });
  }

  return {
    endpoint,
    label,
    status: response.status,
    // The retrieval time of this pull. Two pulls of the same URL in the same
    // second are the only case where these could match.
    requestedAt: requestedAt.toISOString(),
    retrievedAt: retrievedAt.toISOString(),
    userAgent: sentUserAgent,
    // The stamp that named this product, as the origin sent it. Never derived.
    responseHeaders: captureHeaders(response),
    body,
  };
}

export const ageMinutes = (retrievedAtIso, upstreamIso) => {
  if (!upstreamIso) return null;
  const retrieved = Date.parse(retrievedAtIso);
  const upstream = Date.parse(upstreamIso);
  if (Number.isNaN(retrieved) || Number.isNaN(upstream)) return null;
  // Milliseconds, not rounded to a build-time constant.
  return Math.round(((retrieved - upstream) / 60000) * 10) / 10;
};
