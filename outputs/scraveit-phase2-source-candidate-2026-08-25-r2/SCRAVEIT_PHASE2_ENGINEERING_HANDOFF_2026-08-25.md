# Scraveit Phase 2 engineering handoff — 2026-08-25

## Safety boundary

- No Firebase deployment was performed.
- No live production data was read, written, migrated or deleted.
- Active Firebase configuration/rules remain byte-identical to the start checkpoint.
- Package IDs, Firebase application identities and version codes were preserved.
- Safe sanitized source checkpoint: `outputs/checkpoints/scraveit-phase2-start-sanitized-2026-08-25.tar.gz`.

## Implemented

- Customer startup/review hydration, independent realtime-stream ownership, bounded search with recents/debounce, safe address deletion, current-catalog reorder validation, and cart/menu reliability regressions.
- Restaurant alarm reconciliation after process death using an authoritative successful pending-order snapshot without cross-restaurant alarm cancellation.
- Rider offer alarm persistence, expiry, reversible transient-failure pause/re-arm, and explicit OTP capability handling.
- Bounded Admin active/recent order dashboard and bounded immutable-ledger activity snapshot. Full order-root polling was removed; canonical order detail is fetched only when opened.
- Strict Admin projection sanitization and finance snapshot completeness semantics.
- Verified online-payment receipt funds are allocated into the immutable delivery ledger exactly once when a paid order reaches Delivered.
- Authenticated rider arrival at the restaurant now requires fresh, accurate, order-matching pickup tracking. It writes durable evidence without exposing coordinates to Restaurant or Admin.
- Restaurant/Admin handover now requires that durable arrival evidence for the exact order, restaurant and currently assigned rider. Lost-response retries remain idempotent.
- Interrupted `Ready for pickup` to `Assigned` promotion is recovered safely without duplicate transitions or effects.
- Rider job projections preserve a legitimate same-assignment arrival phase while withholding customer address, item and payment detail until handover.
- Restaurant and Rider money screens no longer call estimates receivables, settlements or credited earnings.
- Admin now has a bounded owner-only view of positive rider COD exposure and a verified-remittance action backed by the existing secure `recordCodRemittance` callable. The client preserves the same idempotent request across uncertain responses or app restarts; it never writes wallet or ledger balances directly.
- Staged-only Realtime Database index/rule artifacts for the bounded Admin query. Active rules were not changed.

## Verification performed

- Backend typecheck, build and full Vitest suite: at least 221 automated tests passed in the current source state.
- Native automated checks: 596 premium-validator assertions passed, together with the dedicated customer reliability/search, finance truthfulness, alarm/handover, Admin dashboard/COD-remittance and non-production build-boundary checks.
- Local Firebase Realtime Database rules-emulator suite: 9/9 isolated authorization scenarios passed without deploying or reading live data.
- Fresh post-change debug compilation, release lint, APK assembly, R8 release processing and unsigned AAB assembly completed for Customer, Admin, Restaurant and Rider. Android unit-test tasks currently have no native unit-test sources; behavioral coverage is supplied by the backend, local emulator and native contract suites listed above.
- ZIP integrity and Android signature verification passed for all four current debug APKs. They are debug-signed and production-configured, so they are local inspection builds rather than isolated test or Play release artifacts.
- The fail-closed `isolated` build boundary passed 177 Gradle tasks using synthetic local non-production configurations. It rejects missing, mixed-project, production-project and package-mismatched Firebase inputs and verifies packaged APK/native/WebView configuration parity. Synthetic credentials and APKs were kept outside deliverable artifacts.
- Staged rule generator/validator and active-config immutability checks.

These results are automated source/contract and local-emulator verification only. Physical-device end-to-end testing was not possible in this workspace because no ADB device/emulator was attached. This handoff does **not** claim that the complete four-app COD lifecycle, killed/locked-device push, GPS navigation, OEM battery behavior, temporary-network recovery or multi-device rider race passed on hardware.

## Required rollout sequence

1. Review changes and create a real private source-control checkpoint.
2. Deploy staged functions/indexes/rules only to an isolated non-production Firebase environment.
3. Build all four `isolated` variants from four matching non-production Firebase Android configurations, install those isolated APKs, and run one complete COD lifecycle, one restaurant rejection, two-rider concurrent acceptance, killed-app recovery, temporary-network recovery and multiple simultaneous orders.
4. Resolve any hardware findings and repeat the full suite.
5. Obtain production external credentials/URLs and configure restricted Maps, App Check and Play Integrity.
6. Increment final version codes, sign AABs with the authorized Play upload key, rerun release checks, and only then upload to closed testing.

## Remaining highest-value engineering and validation

- Ledger-derived role-specific restaurant settlement and rider earnings/COD summaries rather than client projections.
- Authorized isolated deployment and physical-device validation of the staged dashboard, arrival/handover, COD remittance and all background notification paths.

## External blockers

- PhonePe production merchant approval/credentials and production webhook configuration.
- A separate non-production Firebase project with matching Customer, Admin, Restaurant and Rider Android registrations/configuration plus non-production App Check test identities.
- Restricted production Maps key.
- Play upload signing key and Play Integrity fingerprints.
- Final privacy policy, terms, support and account-deletion URLs.
- At least two physical Android devices plus final OEM/background-location testing.

## Existing candidate warning and next artifact naming

- `outputs/scraveit-phase2-candidate-2026-08-25` is a **superseded, pre-latest-change candidate**. Its checksums are valid, but all four developer APKs embed the production `savrivo-app` Firebase configuration. They are not isolated-test APKs and must not be used for destructive or synthetic end-to-end testing.
- Keep any production-configured local debug build explicitly named `LOCAL-INSPECTION-ONLY-PRODUCTION-CONFIGURED`; reserve `ISOLATED-NONPROD` for an APK built through the fail-closed isolated variant with matching non-production configuration.
- Package the next current source/build evidence under a revisioned directory such as `outputs/scraveit-phase2-source-candidate-2026-08-25-r2` instead of overwriting the older candidate.
- Release AABs must remain explicitly named `UNSIGNED-NOT-UPLOAD-READY` until authorized signing, final external configuration and physical closed-testing validation are complete.
