#!/usr/bin/env bash
# Rebuild the PDFs in docs/ from their Markdown sources.
#
#   bash tools/build-docs.sh            # build every doc
#   bash tools/build-docs.sh PROPOSAL   # build just one
#
# Markdown -> HTML is tools/md2html.py; HTML -> PDF is headless Chrome, which is
# already on this machine and prints far better tables than any pip package would.
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT=$(pwd)
TMP="${TMPDIR:-/tmp}/meridian-docs"
mkdir -p "$TMP"

# Chrome is a Windows program, so a file:// URL must use a Windows path
# (C:/Users/...). Handing it an MSYS path (/c/Users/...) silently loads nothing
# and prints a blank one-page PDF.
if command -v cygpath >/dev/null 2>&1; then
  TMP_URL=$(cygpath -m "$TMP")
else
  TMP_URL="$TMP"
fi

CHROME=""
for candidate in \
  "/c/Program Files/Google/Chrome/Application/chrome.exe" \
  "/c/Program Files (x86)/Google/Chrome/Application/chrome.exe" \
  "/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"
do
  [ -x "$candidate" ] && CHROME="$candidate" && break
done

if [ -z "$CHROME" ]; then
  echo "No Chrome or Edge found. Install either one, or edit this script." >&2
  exit 1
fi

targets=${1:-}
for md in docs/*.md; do
  name=$(basename "$md" .md)
  [ -n "$targets" ] && [ "$name" != "$targets" ] && continue

  python tools/md2html.py "$md" "$TMP/$name.html"

  # Chrome will not overwrite a PDF that is open in a viewer, so render to a
  # temporary file first and copy it into place.
  "$CHROME" --headless --disable-gpu --no-pdf-header-footer \
    --print-to-pdf="$TMP_URL/$name.pdf" "file:///$TMP_URL/$name.html" 2>/dev/null

  # A blank render means Chrome could not load the page; catch it here rather
  # than shipping an empty PDF.
  if [ ! -s "$TMP/$name.pdf" ] || [ "$(wc -c < "$TMP/$name.pdf")" -lt 30000 ]; then
    echo "$name.pdf rendered nearly empty - Chrome probably could not load the HTML" >&2
    exit 1
  fi

  if cp "$TMP/$name.pdf" "$ROOT/docs/$name.pdf" 2>/dev/null; then
    echo "built docs/$name.pdf"
  else
    echo "docs/$name.pdf is open in another program - close it and run this again" >&2
    exit 1
  fi
done
