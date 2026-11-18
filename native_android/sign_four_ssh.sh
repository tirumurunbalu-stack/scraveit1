#!/bin/zsh
# For the iPhone Shortcut "Sign Scraveit" (Run Script over SSH). The upload-key password
# arrives on standard input from the Shortcut's question, never on the command line.
cd "$(dirname "$0")/build/play-store" || { echo "Folder not found"; exit 1; }
IFS= read -r SCRAVEIT_KEY_PASS
export SCRAVEIT_KEY_PASS
JS=$(/usr/libexec/java_home -v 17 2>/dev/null)/bin/jarsigner
[ -x "$JS" ] || JS=/opt/homebrew/Cellar/openjdk@17/17.0.20.1/libexec/openjdk.jdk/Contents/Home/bin/jarsigner
ok=0; out=""
FILES=(Scraveit-Restaurant-3.14.13.aab Scraveit-Rider-3.16.15.aab)
for f in $FILES; do
  if "$JS" -storepass:env SCRAVEIT_KEY_PASS -keystore ~/scraveit-upload-key/scraveit-upload.jks "$f" scraveit-upload >/dev/null 2>&1 \
     && "$JS" -verify "$f" 2>/dev/null | grep -q "jar verified"; then
    ok=$((ok+1)); out="$out
✓ ${f#Scraveit-}"
  else
    out="$out
✗ ${f#Scraveit-}"
  fi
done
unset SCRAVEIT_KEY_PASS
[ $ok -eq ${#FILES} ] && date "+%d %b %H:%M" > .signed-at
echo "$ok of ${#FILES} signed$out"
