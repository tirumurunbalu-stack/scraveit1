#!/bin/zsh
# Apple App Review login for the Scraveit Admin iPhone app.
# Makes (or updates) appreview-admin@scraveit.in with the password you type, marks it
# savrivoRole "app_review" (opens the app on SAMPLE data only; real data stays locked by the
# server rules), checks the login works, then saves it as the demo login in App Store Connect.
# Nothing shows while typing. The password is never printed or saved on disk.
cd "$(dirname "$0")" || exit 1
EMAIL="appreview-admin@scraveit.in"
PROJECT="savrivo-app"
LOG="$PWD/set_admin_review_login.log"
exec > >(tee "$LOG") 2>&1
echo "Started $(date '+%d %b %H:%M:%S')"
while true; do
  IFS= read -rs "PW?Type a new password for $EMAIL (10+ characters), then Enter: " || exit 1
  echo
  if (( ${#PW} < 10 )); then echo "That was ${#PW} characters. Use 10 or more. Try again."; continue; fi
  IFS= read -rs "PW2?Type the same password again, then Enter: " || exit 1
  echo
  if [[ "$PW" != "$PW2" ]]; then echo "The two did not match. Try again."; continue; fi
  break
done
unset PW2
echo "Password accepted (${#PW} characters)."
TOKEN=$(gcloud auth print-access-token) || { echo "gcloud sign-in needed"; read -k1 "?Press any key to close"; exit 1; }
KEY=$(grep -o 'apiKey: *"[^"]*"' admin/src/main/assets/firebase-config.js | cut -d'"' -f2)
API="https://identitytoolkit.googleapis.com/v1/projects/$PROJECT"
H=(-H "Authorization: Bearer $TOKEN" -H "x-goog-user-project: $PROJECT" -H "Content-Type: application/json")

UID_=$(curl -s -X POST "$API/accounts:lookup" "${H[@]}" -d "{\"email\":[\"$EMAIL\"]}" \
  | python3 -c 'import json,sys; r=json.load(sys.stdin); u=r.get("users") or []; print(u[0]["localId"] if u else "")')
if [[ -z "$UID_" ]]; then
  UID_=$(PW="$PW" EMAIL="$EMAIL" python3 -c 'import json,os; print(json.dumps({"email":os.environ["EMAIL"],"password":os.environ["PW"],"emailVerified":True}))' \
    | curl -s -X POST "$API/accounts" "${H[@]}" -d @- | python3 -c 'import json,sys; r=json.load(sys.stdin); print(r.get("localId") or "ERROR " + str(r.get("error",{}).get("message")))')
  if [[ "$UID_" == ERROR* || -z "$UID_" ]]; then echo "Could not make the account: ${UID_#ERROR }"; read -k1 "?Press any key to close"; exit 1; fi
  echo "Account made."
else
  echo "Account already there, updating it."
fi
PW="$PW" EMAIL="$EMAIL" UID_="$UID_" python3 -c 'import json,os; print(json.dumps({"localId":os.environ["UID_"],"email":os.environ["EMAIL"],"password":os.environ["PW"],"emailVerified":True,"disableUser":False,"customAttributes":json.dumps({"savrivoRole":"app_review"})}))' \
  | curl -s -X POST "$API/accounts:update" "${H[@]}" -d @- \
  | python3 -c 'import json,sys; r=json.load(sys.stdin); print("Password and review role saved.") if "localId" in r else print("Save failed:", r.get("error",{}).get("message"))'
sleep 2
PW="$PW" EMAIL="$EMAIL" python3 -c 'import json,os; print(json.dumps({"email":os.environ["EMAIL"],"password":os.environ["PW"],"returnSecureToken":True}))' \
  | curl -s -X POST "https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=$KEY" -H "Content-Type: application/json" -d @- \
  | python3 -c '
import json,sys,base64
r=json.load(sys.stdin); t=r.get("idToken")
if not t: print("LOGIN CHECK: FAILED -", r.get("error",{}).get("message")); sys.exit()
p=t.split(".")[1]; p+="="*(-len(p)%4); role=json.loads(base64.urlsafe_b64decode(p)).get("savrivoRole")
print("LOGIN CHECK: WORKS, role =", role, "(sample data only)" if role=="app_review" else "<- WRONG, tell Claude")'

cd ../ios/tools || exit 1
EMAIL="$EMAIL" PW="$PW" node --input-type=module -e '
import { asc } from "./asc.mjs";
const app = (await asc("GET", "/v1/apps?filter[bundleId]=in.scraveit.admin")).data[0];
const version = (await asc("GET", `/v1/apps/${app.id}/appStoreVersions?filter[platform]=IOS`)).data
  .find(v => ["PREPARE_FOR_SUBMISSION", "DEVELOPER_REJECTED", "REJECTED", "METADATA_REJECTED", "WAITING_FOR_REVIEW"].includes(v.attributes.appStoreState));
if (!version) { console.log("App Store: no Admin version to edit yet, tell Claude."); process.exit(0); }
const id = (await asc("GET", `/v1/appStoreVersions/${version.id}/appStoreReviewDetail`)).data.id;
await asc("PATCH", `/v1/appStoreReviewDetails/${id}`, { data: { type: "appStoreReviewDetails", id, attributes: {
  demoAccountRequired: true, demoAccountName: process.env.EMAIL, demoAccountPassword: process.env.PW } } });
const after = (await asc("GET", `/v1/appStoreReviewDetails/${id}`)).data.attributes;
console.log(after.demoAccountName && after.demoAccountPassword ? "App Store demo login saved. Tell Claude: saved" : "App Store save failed, try again");
'
unset PW
read -k1 "?Press any key to close"
