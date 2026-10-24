You are working on my Mac on Scraveit (Customer, Restaurant, Partner/Rider, Admin Android apps + Firebase Functions).

Project folder: /Users/balu/Desktop/2026-08-14/scraveit-deploy
Branch: feature/parent-pay-32g08n

## Rules (always)
- Never type, print or echo passwords, API keys, tokens or the App Check debug token. When a secret is needed, run the command and let me paste it into the prompt myself.
- Never read ~/scraveit-upload-key/upload-key-password.txt or play-review-accounts.txt.
- Never delete these deployed functions: auditRestaurantListing, auditRiderDecision, auditSettingsChange, auditStaffAccess.
- Deploy functions ONE AT A TIME (Cloud Run CPU quota). If one fails with quota/503, wait 60 s and retry that one.
- Ask me before accepting any terms, before payments, and before anything in Play Console that publishes to users.
- I do the testing on phones. Keep answers short.
- Commit and push only when I ask.

## Step 0 — Update
```
cd /Users/balu/Desktop/2026-08-14/scraveit-deploy
git pull origin feature/parent-pay-32g08n
cd functions && npm ci && npm test && cd ..
```
All tests must pass before deploying. If something fails, fix it and tell me what was wrong.

## Step 1 — Secrets (I paste each value when asked)
Check what already exists with `firebase functions:secrets:access NAME >/dev/null && echo set` (do not print the value). Only set the missing ones:
```
firebase functions:secrets:set CASHFREE_APP_ID
firebase functions:secrets:set CASHFREE_SECRET_KEY
firebase functions:secrets:set CLOUDFLARE_TURN_KEY_ID
firebase functions:secrets:set CLOUDFLARE_TURN_API_TOKEN
firebase functions:secrets:set PLIVO_AUTH_ID
firebase functions:secrets:set PLIVO_AUTH_TOKEN
firebase functions:secrets:set PLIVO_FROM_NUMBER
firebase functions:secrets:set SARVAM_API_KEY
firebase functions:secrets:set ANTHROPIC_API_KEY
```
- Cloudflare TURN: dashboard → Realtime / Calls → TURN → Create key. It gives a Key ID and an API token. Guide me there if I don't have them.
- CASHFREE_ENV is a plain param (not secret), default `sandbox`. Keep sandbox until I say "go live"; then set `CASHFREE_ENV=production` in `functions/.env.<projectId>` and use the production keys.
- If I don't have Plivo/Sarvam/Anthropic keys yet, skip the voice-agent deploys and tell me.

## Step 2 — Deploy (one at a time, in this order)
```
firebase deploy --only firestore:rules
firebase deploy --only functions:callIceServers
firebase deploy --only functions:onCallWritten
firebase deploy --only functions:onChatMessageCreated
firebase deploy --only functions:cashfreeWebhook
firebase deploy --only functions:cashfreeCheckout
firebase deploy --only functions:createOrder
firebase deploy --only functions:getCheckoutConfiguration
firebase deploy --only functions:createPaymentIntent
firebase deploy --only functions:createPhonePeIntent
firebase deploy --only functions:parentPayRespond
firebase deploy --only functions:onCodOrderConfirmCall
firebase deploy --only functions:voiceAgent
```
If the CLI asks to delete functions that are not in the source, answer NO.

After deploy:
- Give me the cashfreeWebhook URL. I will paste it in Cashfree dashboard → Developers → Webhooks (payment events, latest version).
- Give me the voiceAgent URL for Plivo (Answer URL, POST).
- Admin app → Settings: payment provider = Cashfree.
- Firestore `settings/voiceAgent`: keep `enabled: false` and `onlyPhones: [my number]` for testing first.

## Step 3 — Build and install on my phone
Use the one-command script (finds Java 17 and adb itself):
```
native_android/tools/install_on_phone.sh customer
native_android/tools/install_on_phone.sh restaurant
native_android/tools/install_on_phone.sh admin
native_android/tools/install_on_phone.sh partner
```
Phone must be connected with USB debugging on. If the script or Gradle fails, fix it yourself; don't ask me to install tools by hand unless there's no other way.

Versions: Customer 3.30.0 (186), Restaurant 3.13.4 (85), Partner 3.15.0 (100), Admin 4.5.0 (84).

## Step 4 — What I will test (tell me this checklist after installing)
Customer 3.30.0:
1. Chat: header shows photo, name, @username, not cut at the top.
2. Voice message: hold mic to record, slide left to cancel, tap to lock; play, seek, speed.
3. Photo editor: filters, adjust sliders (double-tap value = reset), effects with strength.
4. Voice call and video call between two friend accounts on two phones; ringing when app is closed; missed-call line in chat.
5. Video call gestures: 👍 thumbs, 🫶 hearts, ✌️ balloons, two 👍 fireworks, two ✌️ confetti, two 👎 rain, 🤟 lasers. First video call downloads ~8 MB once.
6. Payment: UPI app list opens PhonePe/GPay directly; card pays in-app (sandbox).
Restaurant: agreement shows the commission set in Admin; sign box is empty (no name placeholder) and autofill works; PAN/FSSAI not overwritten by autofill.
Voice agent: place a COD order from my number → I get a Telugu/English confirmation call; result in `codConfirmations/{orderId}`.

## Step 5 — Play Store release (only after I say testing is OK)
- Build signed release bundles (the keystore password is entered by me, never read from the file).
- Customer 3.30.0, Restaurant 3.13.4, Partner 3.15.0 → upload to Internal testing first, then ask me before Production.
- Customer Data safety: add Microphone (voice messages, calls) and Camera (video calls) — collected, not shared, not stored on server except voice messages in chat.
- Unpublish old Customer 3.21.18 from Production (ask me first).
- Restaurant Play submission items still open; Dairy, Grocery and Price Planner Play setup — list what's missing and walk me through it.

## Step 6 — Before public launch (remind me, don't run without asking)
- `cd functions && node scripts/migrate-storage-bucket.mjs --apply` (dry-run first, show me the summary).
- Clean test data (test orders, test restaurants, test users) — show me the list before deleting.
- Clean secrets from ~/.zsh_history (remove lines that contain keys; don't print them).
- Pending emails: eShram; FSSAI licence follow-ups.

## Open question for me
Voice agent model: keep Opus 5.5 (best Telugu understanding) or switch to Haiku 5.5 (cheaper, faster)? Ask me once.

When everything in a step is done, tell me in 2–3 lines what's done and what you need from me next.
