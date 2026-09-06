# Savrivo Partner dispatch fix — v3.2.2

## Install this APK

- File: `Savrivo-Partner-v3.2.2.apk`
- Package: `com.feastly.rider`
- Version: `3.2.2` (`36`)
- Android support: Android 6.0 and newer
- SHA-256: `881390ff09c3760d21ef6e344f2f759684bfc90932d13b11937c7339965c320c`

Install it over the current Savrivo Partner app. If Android reports a signing conflict, uninstall only the old Partner app and then install this APK. Rider account and operational records remain in Firebase; uninstalling clears only this phone's local app state.

After installation:

1. Open Savrivo Partner and sign in as the approved rider.
2. Allow notifications and precise location.
3. Switch the rider Offline and then Online once.
4. Keep location enabled. The existing Ready-for-pickup order will be reconsidered automatically.
5. Confirm that the delivery offer card and alert appear, accept it, and verify that the Restaurant app changes from Finding rider to Assigned.

The release AAB beside the APK is unsigned and must be signed with the production Play upload key before publishing.

## Backend status

- Realtime Database rules: deployed to `savrivo-app`.
- Rider dispatch functions: deployed to `asia-south1` on Node.js 22.
- The backend now searches by restaurant city, ranks fresh eligible riders by distance and active workload, offers sequentially, and reopens exhausted Ready orders when an eligible rider comes online.
- Rider offers are private per rider. Exact customer details remain protected until the delivery phase permits access.

## Verification completed

- Functions: 39 tests passed.
- Four-app validation: 505 assertions passed.
- Partner debug APK, release AAB and release lint: passed.
- APK signature verification: passed.
- No physical Android device was connected to the build machine, so the final phone notification, sound, and Accept interaction must be confirmed using the steps above.
