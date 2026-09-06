# Scraveit Phase 2 — verified feature-gap matrix

Status reflects source and automated verification in the staged workspace on 2026-08-25. `WORKING` means a bounded backend/domain or client contract passed automated checks. `PARTIAL` means an important cross-app or device-level path still requires isolated deployment and physical validation, or an external integration is incomplete. No row claims a production deployment or physical-device result.

| Feature | Customer | Restaurant | Rider | Admin | Backend | Status |
|---|---|---|---|---|---|---|
| Authoritative order lifecycle and actor permissions | Live timeline | Valid controls only | Valid delivery controls | Operational visibility | Strict, idempotent transition service | WORKING |
| COD order placement through delivery | Server-priced checkout | Accept/prepare/ready | Claim/pickup/deliver/OTP | Bounded order view | Immutable COD allocation and wallet projection | PARTIAL |
| Verified online-receipt allocation at delivery | Fail-closed gateway boundary | Status visibility | Status visibility | Recent signed ledger activity | Automated verified-receipt provenance and idempotent allocation | PARTIAL |
| New restaurant-order alarm | Status sync | Persistent per-order alarm | — | Order visibility | New-order outbox event | PARTIAL |
| Restaurant alarm reconciliation after process death | — | Authoritative pending-set reconciliation | — | — | Backend remains source of truth | PARTIAL |
| Progressive rider dispatch and first-valid-rider-wins | Assignment sync | Assigned-rider sync | Offer expiry, accept/reject, losing-offer removal | Dispatch/order visibility | Transaction-safe wave dispatch | PARTIAL |
| Rider alert recovery and expiry | — | — | Persisted expiry, transient retry re-arm, terminal stop | — | Offer state authoritative | PARTIAL |
| Cart and checkout reliability | Persistent variants/add-ons/notes, safe reorder, duplicate protection | — | — | — | Server pricing and idempotency | PARTIAL |
| Address management and discovery | Add/edit/delete fallback, serviceability, bounded search, recents | Availability projection | — | Catalog controls | Serviceability and bounded catalog APIs | WORKING |
| Delivery tracking and restart recovery | Stream ownership and one-shot hydration | Order-state recovery | Active-job recovery and adaptive location | Lazy canonical detail | Authoritative projections/tracking evidence | PARTIAL |
| Verified restaurant arrival and handover | Arrival state sync | Handover unlocks only after verified arrival | Authenticated fresh-GPS arrival claim | Safe verification marker only | Durable evidence plus server-side handover gate | PARTIAL |
| Ratings | Order-scoped submission and startup gating | Aggregate display foundation | Aggregate display foundation | Review visibility | Authenticated idempotent persistence | PARTIAL |
| Restaurant/rider finance presentation | — | Delivered-only estimates, not settlement claims | Estimate labels; no false ledger/COD claims | Bounded signed ledger activity with completeness flag | Immutable journals authoritative | PARTIAL |
| Admin operational dashboard | — | — | — | Bounded active/recent projections; no full-order polling | Staged `getAdminDashboard` callable | PARTIAL |
| Admin COD remittance operations | — | — | Wallet projection | Bounded owner-only exposure and verified-remittance UI with restart-stable retry | Secure idempotent callable exists | PARTIAL |
| Physical killed/locked/background notification behavior | Needs device pass | Needs device pass | Needs device pass | Needs device pass | Push/outbox covered by automated tests | BLOCKED_EXTERNAL |
| Real online payments | Gateway UI boundary | — | — | Ledger visibility | PhonePe-compatible abstraction and verified-receipt ledger foundation; no live merchant integration | BLOCKED_EXTERNAL |
| Production release signing and store upload | Unsigned AAB | Unsigned AAB | Unsigned AAB | Unsigned AAB | — | BLOCKED_EXTERNAL |
| Production Maps, App Check and Play Integrity | Configuration boundary | Configuration boundary | Configuration boundary | Configuration boundary | Staged enforcement boundaries | BLOCKED_EXTERNAL |

## Highest remaining engineering gaps

1. Obtain four matching non-production Firebase Android registrations/configurations and run the complete four-device COD lifecycle, killed-app recovery, two-rider race and temporary-network scenarios on real devices through the verified fail-closed `isolated` variants.
2. Deploy the staged dashboard, verified-arrival/COD callables and associated rules/indexes only in that authorized isolated rollout, then validate all four clients against that backend.
3. Complete ledger-derived restaurant settlements and rider earnings/COD summaries; retain the current estimate labels until those views exist.
