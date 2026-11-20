/**
 * Pre-launch switch (founder 19 Nov 2026): settings/customer.openingSoon === true lets stores be
 * online in the apps while only test accounts can order (services/testAccounts.ts assertMayPlaceOrder).
 * Every order path goes through createAuthoritativeOrder, so app versions already on phones are covered.
 */
export const OPENING_SOON_MESSAGE = "Scraveit is opening soon! You can order once we launch.";

export function isOpeningSoon(settings: unknown): boolean {
  return typeof settings === "object" && settings !== null && (settings as {openingSoon?: unknown}).openingSoon === true;
}
