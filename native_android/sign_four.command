#!/bin/zsh
# Signs the 4 new bundles (14 Nov 2026) with the upload key. Type the upload-key password once
# when asked (nothing shows while typing). It is kept only in this window's memory.
cd "$(dirname "$0")/build/play-store" || exit 1
read -s "SCRAVEIT_KEY_PASS?Upload-key password: "; echo
export SCRAVEIT_KEY_PASS
ok=0
for f in Scraveit-Customer-3.32.4.aab Scraveit-Rider-3.16.11.aab Scraveit-Admin-4.5.3.aab Scraveit-Restaurant-3.14.12.aab; do
  echo "Signing $f"
  if jarsigner -storepass:env SCRAVEIT_KEY_PASS -keystore ~/scraveit-upload-key/scraveit-upload.jks "$f" scraveit-upload >/dev/null; then
    jarsigner -verify "$f" | tail -1; ok=$((ok+1))
  else
    echo "  Signing failed for $f"
  fi
done
unset SCRAVEIT_KEY_PASS
echo
echo "$ok of 4 signed."
read -k1 "?Press any key to close"
