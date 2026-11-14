#!/bin/zsh
# Signs only Restaurant 3.14.11 with the upload key. Type the upload-key password when asked
# (nothing shows while typing).
cd "$(dirname "$0")/build/play-store" || exit 1
f=Scraveit-Restaurant-3.14.11.aab
echo "Signing $f"
jarsigner -keystore ~/scraveit-upload-key/scraveit-upload.jks "$f" scraveit-upload || { echo "Signing failed"; read -k1 "?Press any key to close"; exit 1; }
jarsigner -verify "$f" | tail -1
echo
echo "Signed. Upload it in Play Console when you are ready."
read -k1 "?Press any key to close"
