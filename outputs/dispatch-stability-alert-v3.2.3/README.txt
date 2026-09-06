SAVRIVO DISPATCH STABILITY + CUSTOM ALERT BUILD
Built: 22 August 2026

Install these three APKs over the current apps:
1. Savrivo-Restaurant-v3.2.3.apk
2. Savrivo-Partner-v3.2.3.apk
3. Savrivo-Admin-v3.2.1.apk

Fixed:
- Rider pickup distance now uses a fresh, legal GPS fix with <=100 m reported accuracy.
- Impossible/out-of-service-area coordinates are rejected instead of displaying absurd distances.
- Pickup distance is labelled as an approximate straight-line GPS estimate; Maps navigation provides the live road route.
- Rider offer action time increased from 30 to 90 seconds.
- The same unclaimed order cannot repeatedly reappear to the same rider for five minutes.
- Out-of-order Rider refresh responses cannot bring back an expired offer.
- Accept/Decline is single-flight, and an expired offer sheet closes cleanly.
- Restaurant and Partner action alarms use the supplied Savrivo audio and stop on handled/expired events.
- Admin order/support alerts use the supplied Savrivo audio.

Backend:
- claimRiderOrder, declineRiderOrder, dispatchOfferTimeout, onOrderUpdated, and onRiderPresenceUpdated deployed successfully to savrivo-app on Node.js 22.
- No database-rule republish was required.

Verification:
- Functions: typecheck + build + 41 tests passed.
- Four-app validation: 509 assertions passed.
- Admin, Restaurant, Partner: debug APK, release bundle, and release lint passed.
- All three APKs verified with Android v1 and v2 signatures.
- The packaged audio SHA-256 in every app is f492c4f7d56d76ecd735537da68c452db7d8024fdd27c745164c1297187050ef.

Test flow:
1. Install all three APKs.
2. Force-close and reopen each app once.
3. In Partner, turn Location on and switch Online.
4. Create a new order and progress it to Ready for pickup.
5. Confirm the offer remains stable, shows a sensible approximate pickup distance, and the supplied alert plays.
6. Accept or decline; confirm the alert stops immediately and the offer does not return.
