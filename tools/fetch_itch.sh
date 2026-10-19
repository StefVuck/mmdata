#!/usr/bin/env bash
# Download one day of Nasdaq TotalView-ITCH 5.0 sample data (several GB, gzipped).
# Browse https://emi.nasdaq.com/ITCH/Nasdaq%20ITCH/ for the dates on offer.
set -euo pipefail

file="${1:-01302019.NASDAQ_ITCH50.gz}"
mkdir -p data
curl -fL --retry 3 -C - -o "data/$file" "https://emi.nasdaq.com/ITCH/Nasdaq%20ITCH/$file"
echo "saved data/$file"
echo "next: python3 tools/slice_itch.py data/$file --start 09:29:59.950 --ms 200 --out data/open.itch"
