Install the latest Scraveit builds on my phone so I can test them.

Project: /Users/balu/Desktop/2026-08-14/scraveit-deploy
Branch: feature/parent-pay-32g08n

Rules: never print passwords, keys or tokens; never read ~/scraveit-upload-key/upload-key-password.txt or play-review-accounts.txt; deploy functions one at a time; never delete auditRestaurantListing, auditRiderDecision, auditSettingsChange, auditStaffAccess (answer NO if the CLI asks to delete functions); skip everything about the voice agent (onCodOrderConfirmCall, voiceAgent, Plivo, Sarvam) for now; keep answers short; fix build errors yourself.

1. Get the latest code and check it:
   ```
   cd /Users/balu/Desktop/2026-08-14/scraveit-deploy
   git pull origin feature/parent-pay-32g08n
   cd functions && npm ci && npm test && cd ..
   ```

2. Deploy what the new app features need, one at a time (if one fails with quota/503, wait 60 s and retry it):
   ```
   firebase deploy --only firestore:rules
   firebase deploy --only functions:callIceServers
   firebase deploy --only functions:onCallWritten
   firebase deploy --only functions:onChatMessageCreated
   ```
   Then check (without printing values) whether CASHFREE_APP_ID and CASHFREE_SECRET_KEY secrets exist. If both exist, also deploy one at a time: cashfreeWebhook, cashfreeCheckout, createOrder, getCheckoutConfiguration, createPaymentIntent, createPhonePeIntent, parentPayRespond. If they don't exist, skip and tell me.
   Cloudflare TURN secrets (CLOUDFLARE_TURN_KEY_ID, CLOUDFLARE_TURN_API_TOKEN) are optional for now; calls work on Wi-Fi without them. Just tell me if they're missing.

3. Install on the phone (USB debugging on, phone unlocked). Run one at a time:
   ```
   native_android/tools/install_on_phone.sh customer
   native_android/tools/install_on_phone.sh restaurant
   native_android/tools/install_on_phone.sh admin
   native_android/tools/install_on_phone.sh partner
   ```
   If the phone has the Play Store version and the install fails with a signature mismatch, ask me before uninstalling (uninstall signs me out).
   For calls I need two phones: after the first phone, ask me to plug in the second one and install customer again.

4. Confirm the versions on the phone with `adb shell dumpsys package <package> | grep versionName` and tell me:
   Customer 3.30.0, Restaurant 3.13.4, Admin 4.5.0, Partner 3.15.0.

5. Then give me this test list:
   - Customer chat: header shows photo, name, @username (not cut at top).
   - Voice message: hold mic, slide left to cancel, tap to lock; play, seek, speed.
   - Photo editor: filters, adjust sliders (double-tap value = reset), effects with strength.
   - Voice and video calls between two friend accounts; rings when the app is closed; missed call shows in chat.
   - Video gestures: 👍 thumbs, 🫶 hearts, ✌️ balloons, two 👍 fireworks, two ✌️ confetti, two 👎 rain, 🤟 lasers (first video call downloads ~8 MB once).
   - Payment (if Cashfree deployed): UPI apps open directly; card pays in-app.
   - Restaurant agreement: shows Admin's commission; sign box empty, autofill works, PAN/FSSAI not overwritten.

Don't commit or push anything unless I ask.
