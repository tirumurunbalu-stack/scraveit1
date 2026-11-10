#!/bin/zsh
# Signs only the Customer 3.32.3 Play bundle with the upload key. Double-click to run; type the
# upload-key password when asked (nothing shows while typing).
cd "$(dirname "$0")/build/play-store" || exit 1
f=Scraveit-Customer-3.32.3.aab
echo "Signing $f"
jarsigner -keystore ~/scraveit-upload-key/scraveit-upload.jks "$f" scraveit-upload || { echo "Signing failed"; read -k1 "?Press any key to close"; exit 1; }
jarsigner -verify "$f" | tail -1
open -R "$f"
read -k1 "?Press any key to close"
