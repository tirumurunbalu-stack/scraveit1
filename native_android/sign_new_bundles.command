#!/bin/zsh
# Signs the new Play bundles with the upload key. Double-click to run; type the
# upload-key password when asked (nothing shows while typing).
cd "$(dirname "$0")/build/play-store" || exit 1
for f in Scraveit-Rider-3.16.6.aab Scraveit-Restaurant-3.14.10.aab Scraveit-Customer-3.32.3.aab; do
  echo
  echo "Signing $f"
  jarsigner -keystore ~/scraveit-upload-key/scraveit-upload.jks "$f" scraveit-upload || { echo "Signing failed for $f"; read -k1 "?Press any key to close"; exit 1; }
  jarsigner -verify "$f" | tail -1
done
echo
echo "Signed. Upload them in Play Console."
open -R Scraveit-Rider-3.16.6.aab
read -k1 "?Press any key to close"
