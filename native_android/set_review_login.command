#!/bin/zsh
# Sets the Google Play test rider login (playreview-rider@scraveit.in) to the password you
# paste, then signs in with it exactly like the Rider app does and says if it works.
# Copy the password from Play Console > App content > Sign-in details > playreview > edit.
# Nothing shows while pasting.
cd "$(dirname "$0")" || exit 1
IFS= read -rs "PW?Paste the Play Console test password, then Enter: "
echo
IFS= read -rs "PW2?Paste it again, then Enter: "
echo
if [[ "$PW" != "$PW2" ]]; then echo "The two did not match. Close this window and try again."; read -k1 "?Press any key to close"; exit 1; fi
unset PW2
echo "You pasted ${#PW} characters (Play Console has 10)."
TOKEN=$(gcloud auth print-access-token) || { echo "gcloud sign-in needed"; read -k1 "?Press any key to close"; exit 1; }
KEY=$(grep -o 'apiKey: *"[^"]*"' rider/src/main/assets/firebase-config.js | cut -d'"' -f2)
PW="$PW" python3 -c 'import json,os; print(json.dumps({"localId":"37FOVnbX2AduLTr0X9MptJnuu5U2","email":"playreview-rider@scraveit.in","password":os.environ["PW"],"emailVerified":True,"disableUser":False}))' | curl -s -X POST "https://identitytoolkit.googleapis.com/v1/projects/savrivo-app/accounts:update" \
  -H "Authorization: Bearer $TOKEN" -H "x-goog-user-project: savrivo-app" -H "Content-Type: application/json" -d @- \
  | python3 -c 'import json,sys; r=json.load(sys.stdin); print("Password saved for", r["email"]) if "email" in r else print("Save failed:", r.get("error",{}).get("message"))'
sleep 2
PW="$PW" python3 -c 'import json,os; print(json.dumps({"email":"playreview-rider@scraveit.in","password":os.environ["PW"],"returnSecureToken":True}))' | curl -s -X POST "https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=$KEY" -H "Content-Type: application/json" -d @- \
  | python3 -c 'import json,sys; r=json.load(sys.stdin); print("LOGIN CHECK: WORKS. Google can sign in.") if r.get("idToken") else print("LOGIN CHECK: FAILED -", r.get("error",{}).get("message"))'
unset PW
read -k1 "?Press any key to close"
