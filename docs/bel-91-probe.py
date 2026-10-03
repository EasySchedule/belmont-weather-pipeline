#!/usr/bin/env python3
"""BEL-91 reproduction probe for api.weather.gov PBZ/50,48.

Each round pulls /forecast four ways to separate origin product from edge cache:
  plain            - default GET, as the newsroom pipeline pulls it
  no-cache         - Cache-Control: no-cache  (revalidate)
  no-store         - Cache-Control: no-cache, no-store
  if-none-match    - conditional GET against the previous ETag (expect 200 vs 304)

Records every observable that the endpoint exposes for provenance, and a
stable content hash of the body and of period 1 so that a later pull returning
a different product under one Last-Modified stamp is detectable, not invisible.
"""

import hashlib
import json
import os
import subprocess
import sys
import time
from datetime import datetime, timezone

FORECAST = "https://api.weather.gov/gridpoints/PBZ/50,48/forecast"
GRID = "https://api.weather.gov/gridpoints/PBZ/50,48"
UA = (
    "BelmontNews/1.0 (Belmont News weather pipeline; "
    "grant.kowalczyk@belmontnews.example; +https://belmont-news.example)"
)
OUT = sys.argv[1]
ROUNDS = int(sys.argv[2]) if len(sys.argv) > 2 else 12
INTERVAL = int(sys.argv[3]) if len(sys.argv) > 3 else 45


def sha256(s):
    return hashlib.sha256(s.encode()).hexdigest()[:16]


def pull(url, extra_headers):
    cmd = ["curl", "-sS", "--max-time", "30", "-D", "-", url, "-H", f"User-Agent: {UA}"]
    for k, v in extra_headers.items():
        cmd += ["-H", f"{k}: {v}"]
    p = subprocess.run(cmd, capture_output=True)
    raw = p.stdout
    sep = raw.find(b"\r\n\r\n")
    if sep < 0:
        sep = raw.find(b"\n\n")
        head, body = raw[:sep], raw[sep + 2 :]
    else:
        head, body = raw[:sep], raw[sep + 4 :]
    lines = head.decode("utf-8", "replace").splitlines()
    status = int(lines[0].split()[1]) if lines and " " in lines[0] else 0
    h = {}
    for line in lines[1:]:
        if ":" in line:
            k, v = line.split(":", 1)
            h[k.strip().lower()] = v.strip()
    return status, h, body


def summarize(label, status, h, body, pulled_at):
    rec = {
        "variant": label,
        "pulledAt": pulled_at,
        "status": status,
        "lastModified": h.get("last-modified"),
        "etag": h.get("etag"),
        "age": h.get("age"),
        "xCache": h.get("x-cache"),
        "xEdgeRequestId": h.get("x-edge-request-id"),
        "xServerId": h.get("x-server-id"),
        "xRequestId": h.get("x-request-id"),
        "xCorrelationId": h.get("x-correlation-id"),
        "serverTiming": h.get("server-timing"),
        "cacheControl": h.get("cache-control"),
        "contentLength": h.get("content-length"),
        "bodySha256_16": sha256(body.decode("utf-8", "replace")) if body else None,
        "bodyBytes": len(body),
    }
    if status != 200 or not body:
        rec["period1"] = None
        return rec
    try:
        d = json.loads(body)
    except Exception as e:  # noqa: BLE001
        rec["parseError"] = str(e)
        rec["period1"] = None
        return rec
    p = d.get("properties", {})
    rec["generatedAt"] = p.get("generatedAt")
    rec["updateTime"] = p.get("updateTime")
    rec["validTimes"] = p.get("validTimes")
    rec["elevation"] = (p.get("grid") or {}).get("elevation")
    per = (p.get("periods") or [{}])[0]
    pop = (per.get("probabilityOfPrecipitation") or {}).get("value")
    rec["period1"] = {
        "number": per.get("number"),
        "name": per.get("name"),
        "startTime": per.get("startTime"),
        "endTime": per.get("endTime"),
        "temperature": per.get("temperature"),
        "probabilityOfPrecipitation": pop,
        "shortForecast": per.get("shortForecast"),
        "detailedForecast": per.get("detailedForecast"),
    }
    rec["period1Sha256_16"] = sha256(json.dumps(per, sort_keys=True))
    rec["periods2PlusSha256_16"] = sha256(
        json.dumps((p.get("periods") or [])[1:], sort_keys=True)
    )
    return rec


def main():
    prev_etag = None
    rounds = []
    for i in range(ROUNDS):
        pulled_at = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        recs = []
        for label, hdrs in (
            ("plain", {}),
            ("no-cache", {"Cache-Control": "no-cache"}),
            ("no-store", {"Cache-Control": "no-cache, no-store"}),
            (
                "if-none-match",
                {"If-None-Match": prev_etag} if prev_etag else {"Pragma": "no-cache"},
            ),
        ):
            st, h, body = pull(FORECAST, hdrs)
            recs.append(summarize(label, st, h, body, pulled_at))
            if label == "plain" and st == 200:
                prev_etag = h.get("etag") or prev_etag

        st, h, body = pull(GRID, {})
        grid_rec = {"status": st, "lastModified": h.get("last-modified"), "etag": h.get("etag")}
        if st == 200 and body:
            try:
                g = json.loads(body)["properties"]
                grid_rec.update(
                    {
                        "updateTime": g.get("updateTime"),
                        "validTimes": g.get("validTimes"),
                        "elevation": (g.get("grid") or {}).get("elevation"),
                        "bodySha256_16": sha256(body.decode()),
                    }
                )
            except Exception as e:  # noqa: BLE001
                grid_rec["parseError"] = str(e)

        # Distinct products served under one Last-Modified within this single round.
        by_lm = {}
        for r in recs:
            if r["status"] == 200 and r.get("period1"):
                by_lm.setdefault(r["lastModified"], set()).add(r["bodySha256_16"])
        round_entry = {
            "round": i + 1,
            "pulledAt": pulled_at,
            "polls": recs,
            "grid": grid_rec,
            "distinctBodiesUnderOneLastModified": sum(1 for v in by_lm.values() if len(v) > 1),
            "lastModifiedSet": sorted(k for k in by_lm if k),
            "generatedAtSet": sorted({r["generatedAt"] for r in recs if r.get("generatedAt")}),
        }
        rounds.append(round_entry)
        with open(OUT, "w") as f:
            json.dump(
                {
                    "issue": "BEL-91",
                    "endpoint": FORECAST,
                    "userAgent": UA,
                    "startedAt": rounds[0]["pulledAt"],
                    "updatedAt": pulled_at,
                    "rounds": rounds,
                },
                f,
                indent=2,
            )
        print(
            f"round {i+1}/{ROUNDS} {pulled_at} "
            + " ".join(
                f"{r['variant']}:{r['status']}:{r.get('generatedAt')}:"
                f"{(r.get('period1') or {}).get('probabilityOfPrecipitation')}"
                for r in recs
            ),
            flush=True,
        )
        if i < ROUNDS - 1:
            time.sleep(INTERVAL)


if __name__ == "__main__":
    main()