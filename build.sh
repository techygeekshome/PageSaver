#!/usr/bin/env bash
# Builds the release packages into dist/.
#   PageSaver.zip          Chrome, Edge, Brave, Opera, Vivaldi (unzip, then Load unpacked)
#   PageSaver-chrome.zip   same files, named for Chrome users
#   PageSaver-edge.zip     same files, named for Edge users
#   PageSaver-firefox.zip  Firefox package (Firefox manifest, files at the root)
set -euo pipefail
cd "$(dirname "$0")"
FILES="background.js scan.js results.html results.css results.js streams.js mp4.js zip.js lib-mux-mp4.js LICENSE-mux.js.txt icons"
OUT=dist; TMP=$(mktemp -d)
mkdir -p "$OUT"
rm -f "$OUT"/PageSaver*.zip

mkdir "$TMP/page-saver"
cp -r $FILES manifest.json "$TMP/page-saver/"
(cd "$TMP" && zip -qr -X pkg.zip page-saver)
for n in PageSaver PageSaver-chrome PageSaver-edge; do cp "$TMP/pkg.zip" "$OUT/$n.zip"; done

mkdir "$TMP/ff"
cp -r $FILES "$TMP/ff/"
cp manifest.firefox.json "$TMP/ff/manifest.json"
(cd "$TMP/ff" && zip -qr -X ../ff.zip .)
cp "$TMP/ff.zip" "$OUT/PageSaver-firefox.zip"

rm -r "$TMP"
ls -l "$OUT"
