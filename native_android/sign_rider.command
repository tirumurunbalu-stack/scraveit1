#!/bin/zsh
# Signs only Rider 3.16.8 with the upload key. Type the upload-key password when asked
# (nothing shows while typing).
cd "$(dirname "$0")/build/play-store" || exit 1
f=Scraveit-Rider-3.16.8.aab
echo "Signing $f"
jarsigner -keystore ~/scraveit-upload-key/scraveit-upload.jks "$f" scraveit-upload || { echo "Signing failed"; read -k1 "?Press any key to close"; exit 1; }
jarsigner -verify "$f" | tail -1
echo
echo "Signed. Claude uploads it to Play now."
read -k1 "?Press any key to close"
