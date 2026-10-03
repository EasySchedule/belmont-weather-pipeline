#!/usr/bin/env bash
# Evidence capture for BEL-79. Every number below comes from a live pull made in
# this run. Nothing here is transcribed from a document.
set -uo pipefail

OUT="${1:?usage: collect-evidence.sh <output-dir>}"
mkdir -p "$OUT"
cd "$(dirname "$0")/.."
ROOT="$PWD"

UA='BelmontNews/1.0 (https://belmont-news.example; m.vance@agentmail.to)'
MET='https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=40.1006&lon=-80.8501'
NWS='https://api.weather.gov/gridpoints/PBZ/50,48/forecast'

echo "### AC1  raw reachability of MET Norway, curl, with the identifying User-Agent"
echo '$ curl -sS -o met.json -w "HTTP %{http_code} bytes=%{size_download}
" \'
echo "    -H 'User-Agent: $UA' \\"
echo "    '$MET'"
curl -sS -o "$OUT/met-raw.json" -w 'HTTP %{http_code} bytes=%{size_download} time=%{time_total}s
' \
  -H "User-Agent: $UA" "$MET"
echo
echo '$ curl -sS -D - -o /dev/null -H "User-Agent: <same>" <same URL>'
curl -sS -D - -o /dev/null -H "User-Agent: $UA" "$MET" | sed -n '1,14p'
echo
echo '$ curl -sS -o met-no-ua.json -w "HTTP %{http_code}
" <same URL with NO User-Agent>'
curl -sS -o "$OUT/met-no-ua.txt" -w 'HTTP %{http_code} bytes=%{size_download}
' -A '' "$MET"
echo
echo '$ curl -sS -o met-bad-ua.json -w "HTTP %{http_code}
" <same URL with a non-identifying User-Agent>'
curl -sS -o "$OUT/met-bad-ua.txt" -w 'HTTP %{http_code} bytes=%{size_download}
' \
  -A 'python-requests/2.31' "$MET"
echo

echo "### AC1  raw reachability of the NWS source of record, curl"
echo '$ curl -sS -o nws.json -w "HTTP %{http_code} bytes=%{size_download}
" \'
echo "    -H 'User-Agent: $UA' \\"
echo "    '$NWS'"
curl -sS -o "$OUT/nws-raw.json" -w 'HTTP %{http_code} bytes=%{size_download} time=%{time_total}s
' \
  -H "User-Agent: $UA" "$NWS"
echo

echo "### AC2, AC3, AC5, AC6, AC7  the pipeline, first run, against the live endpoints"
node bin/weather-roundup.mjs --edition morning --out "$OUT/run-A.json" --pretty
echo "exit=$?"
echo

echo "### AC4  the same command a second time, with no build, bundle, or compile step between"
echo "There is no build step in this package. There is nothing to run between these"
echo "two commands but the second one. Both are the same file, unmodified, and the"
echo "modification time of every file in the package is printed below to show that."
echo '$ ls -l --time-style=full-iso src bin'
ls -l --time-style=full-iso src bin | sed 's/^/    /'
echo '$ node bin/weather-roundup.mjs --edition morning --out run-B.json --pretty'
node bin/weather-roundup.mjs --edition morning --out "$OUT/run-B.json" --pretty
echo "exit=$?"
echo

echo "### AC4  the two retrieval times, side by side"
python3 - "$OUT/run-A.json" "$OUT/run-B.json" <<'PY'
import json, sys
a = json.load(open(sys.argv[1])); b = json.load(open(sys.argv[2]))
print(f"{'source':<28} {'run A retrievedAt':<28} {'run B retrievedAt':<28} differ")
for sa, sb in zip(a['sources'], b['sources']):
    same = sa['retrievedAt'] == sb['retrievedAt']
    print(f"{sa['source']:<28} {sa['retrievedAt']:<28} {sb['retrievedAt']:<28} {not same}")
print()
print('artifact startedAt A', a['startedAt'], ' B', b['startedAt'])
PY
