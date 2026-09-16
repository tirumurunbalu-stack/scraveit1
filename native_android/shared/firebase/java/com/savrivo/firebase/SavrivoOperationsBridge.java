package com.savrivo.firebase;

import android.Manifest;
import android.app.Activity;
import android.app.NotificationManager;
import android.content.pm.PackageManager;
import android.os.Build;
import android.util.Log;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.HashSet;
import java.util.Set;

/** Narrow native bridge exposed only to the locally packaged, trusted WebView page. */
public final class SavrivoOperationsBridge {
    private static final String TAG = "SavrivoCloudBridge";
    public interface TrustedPage {
        boolean isTrusted();
    }

    private static final int NOTIFICATION_PERMISSION_REQUEST = 8431;
    private final Activity activity;
    private final WebView webView;
    private final TrustedPage trustedPage;

    public SavrivoOperationsBridge(Activity activity, WebView webView, TrustedPage trustedPage) {
        this.activity = activity;
        this.webView = webView;
        this.trustedPage = trustedPage;
    }

    @JavascriptInterface public void registerPushToken(String requestId, String idToken) {
        invokeOnMain(requestId, "NATIVE_PUSH_REGISTRATION_UNAVAILABLE", () -> {
            if (!valid(requestId, idToken)) {
                respond(requestId, false, "{\"error\":{\"message\":\"INVALID_REQUEST\"}}");
                return;
            }
            requestNotificationPermission();
            SavrivoCallableClient.registerPushToken(activity, idToken,
                    (success, json) -> respond(requestId, success, json));
        });
    }

    @JavascriptInterface public void unregisterPushToken(String requestId, String idToken) {
        invokeOnMain(requestId, "NATIVE_PUSH_UNREGISTER_UNAVAILABLE", () -> {
            if (!valid(requestId, idToken)) {
                respond(requestId, false, "{\"error\":{\"message\":\"INVALID_REQUEST\"}}");
                return;
            }
            SavrivoCallableClient.unregisterPushToken(activity, idToken,
                    (success, json) -> respond(requestId, success, json));
        });
    }

    @JavascriptInterface public void updateOrderStatus(
            String requestId, String idToken, String payloadJson) {
        try {
            if (payloadJson == null || payloadJson.length() > 64_000) {
                respond(requestId, false, "{\"error\":{\"message\":\"INVALID_REQUEST\"}}");
                return;
            }
            JSONObject payload = new JSONObject(payloadJson);
            invokeOnMain(requestId, "NATIVE_ORDER_UPDATE_UNAVAILABLE", () -> {
                if (!valid(requestId, idToken)) {
                    respond(requestId, false, "{\"error\":{\"message\":\"INVALID_REQUEST\"}}");
                    return;
                }
                SavrivoCallableClient.updateOrderStatus(activity, idToken, payload,
                        (success, json) -> respond(requestId, success, json));
            });
        } catch (Throwable error) {
            Log.e(TAG, "updateOrderStatus bridge failed", error);
            respond(requestId, false,
                    "{\"error\":{\"message\":\"NATIVE_ORDER_UPDATE_UNAVAILABLE\"}}");
        }
    }

    @JavascriptInterface public void getAdminDashboard(
            String requestId, String idToken, String payloadJson) {
        try {
            if (payloadJson == null || payloadJson.length() > 64_000) {
                respond(requestId, false, "{\"error\":{\"message\":\"INVALID_REQUEST\"}}");
                return;
            }
            JSONObject payload = new JSONObject(payloadJson);
            invokeOnMain(requestId, "NATIVE_ADMIN_DASHBOARD_UNAVAILABLE", () -> {
                if (!valid(requestId, idToken)
                        || !"admin".equals(SavrivoFirebase.appRole(activity))) {
                    respond(requestId, false,
                            "{\"error\":{\"message\":\"INVALID_REQUEST\"}}");
                    return;
                }
                SavrivoCallableClient.getAdminDashboard(activity, idToken, payload,
                        (success, json) -> respond(requestId, success, json));
            });
        } catch (Throwable error) {
            Log.e(TAG, "getAdminDashboard bridge failed", error);
            respond(requestId, false,
                    "{\"error\":{\"message\":\"NATIVE_ADMIN_DASHBOARD_UNAVAILABLE\"}}");
        }
    }

    @JavascriptInterface public void recordCodRemittance(
            String requestId, String idToken, String payloadJson) {
        try {
            if (payloadJson == null || payloadJson.length() > 64_000) {
                respond(requestId, false, "{\"error\":{\"message\":\"INVALID_REQUEST\"}}");
                return;
            }
            JSONObject payload = new JSONObject(payloadJson);
            if (!validCodRemittancePayload(payload)) {
                respond(requestId, false, "{\"error\":{\"message\":\"INVALID_REQUEST\"}}");
                return;
            }
            invokeOnMain(requestId, "NATIVE_COD_REMITTANCE_UNAVAILABLE", () -> {
                if (!valid(requestId, idToken)
                        || !"admin".equals(SavrivoFirebase.appRole(activity))) {
                    respond(requestId, false,
                            "{\"error\":{\"message\":\"INVALID_REQUEST\"}}");
                    return;
                }
                SavrivoCallableClient.recordCodRemittance(activity, idToken, payload,
                        (success, json) -> respond(requestId, success, json));
            });
        } catch (Throwable error) {
            Log.e(TAG, "recordCodRemittance bridge failed", error);
            respond(requestId, false,
                    "{\"error\":{\"message\":\"NATIVE_COD_REMITTANCE_UNAVAILABLE\"}}");
        }
    }

    @JavascriptInterface public void recordRiderPayout(
            String requestId, String idToken, String payloadJson) {
        try {
            if (payloadJson == null || payloadJson.length() > 64_000) {
                respond(requestId, false, "{\"error\":{\"message\":\"INVALID_REQUEST\"}}");
                return;
            }
            JSONObject payload = new JSONObject(payloadJson);
            invokeOnMain(requestId, "NATIVE_RIDER_PAYOUT_UNAVAILABLE", () -> {
                if (!valid(requestId, idToken)
                        || !"admin".equals(SavrivoFirebase.appRole(activity))) {
                    respond(requestId, false,
                            "{\"error\":{\"message\":\"INVALID_REQUEST\"}}");
                    return;
                }
                SavrivoCallableClient.recordRiderPayout(activity, idToken, payload,
                        (success, json) -> respond(requestId, success, json));
            });
        } catch (Throwable error) {
            Log.e(TAG, "recordRiderPayout bridge failed", error);
            respond(requestId, false,
                    "{\"error\":{\"message\":\"NATIVE_RIDER_PAYOUT_UNAVAILABLE\"}}");
        }
    }

    @JavascriptInterface public void recordRestaurantSettlement(
            String requestId, String idToken, String payloadJson) {
        try {
            if (payloadJson == null || payloadJson.length() > 64_000) {
                respond(requestId, false, "{\"error\":{\"message\":\"INVALID_REQUEST\"}}");
                return;
            }
            JSONObject payload = new JSONObject(payloadJson);
            invokeOnMain(requestId, "NATIVE_RESTAURANT_SETTLEMENT_UNAVAILABLE", () -> {
                if (!valid(requestId, idToken)
                        || !"admin".equals(SavrivoFirebase.appRole(activity))) {
                    respond(requestId, false,
                            "{\"error\":{\"message\":\"INVALID_REQUEST\"}}");
                    return;
                }
                SavrivoCallableClient.recordRestaurantSettlement(activity, idToken, payload,
                        (success, json) -> respond(requestId, success, json));
            });
        } catch (Throwable error) {
            Log.e(TAG, "recordRestaurantSettlement bridge failed", error);
            respond(requestId, false,
                    "{\"error\":{\"message\":\"NATIVE_RESTAURANT_SETTLEMENT_UNAVAILABLE\"}}");
        }
    }

    @JavascriptInterface public void getRiderFinancialSummary(
            String requestId, String idToken, String payloadJson) {
        try {
            if (payloadJson == null || payloadJson.length() > 64_000) {
                respond(requestId, false, "{\"error\":{\"message\":\"INVALID_REQUEST\"}}");
                return;
            }
            JSONObject payload = new JSONObject(payloadJson);
            invokeOnMain(requestId, "NATIVE_RIDER_FINANCE_UNAVAILABLE", () -> {
                String appRole = SavrivoFirebase.appRole(activity);
                if (!valid(requestId, idToken)
                        || !("rider".equals(appRole) || "admin".equals(appRole))) {
                    respond(requestId, false,
                            "{\"error\":{\"message\":\"INVALID_REQUEST\"}}");
                    return;
                }
                SavrivoCallableClient.getRiderFinancialSummary(activity, idToken, payload,
                        (success, json) -> respond(requestId, success, json));
            });
        } catch (Throwable error) {
            Log.e(TAG, "getRiderFinancialSummary bridge failed", error);
            respond(requestId, false,
                    "{\"error\":{\"message\":\"NATIVE_RIDER_FINANCE_UNAVAILABLE\"}}");
        }
    }

    @JavascriptInterface public void getRiderRewardsDashboard(
            String requestId, String idToken, String payloadJson) {
        try {
            if (payloadJson == null || payloadJson.length() > 64_000) {
                respond(requestId, false, "{\"error\":{\"message\":\"INVALID_REQUEST\"}}");
                return;
            }
            JSONObject payload = new JSONObject(payloadJson);
            invokeOnMain(requestId, "NATIVE_RIDER_REWARDS_UNAVAILABLE", () -> {
                String appRole = SavrivoFirebase.appRole(activity);
                if (!valid(requestId, idToken)
                        || !("rider".equals(appRole) || "admin".equals(appRole))) {
                    respond(requestId, false,
                            "{\"error\":{\"message\":\"INVALID_REQUEST\"}}");
                    return;
                }
                SavrivoCallableClient.getRiderRewardsDashboard(activity, idToken, payload,
                        (success, json) -> respond(requestId, success, json));
            });
        } catch (Throwable error) {
            Log.e(TAG, "getRiderRewardsDashboard bridge failed", error);
            respond(requestId, false,
                    "{\"error\":{\"message\":\"NATIVE_RIDER_REWARDS_UNAVAILABLE\"}}");
        }
    }

    @JavascriptInterface public void getAdminRiderRewardsDashboard(
            String requestId, String idToken, String payloadJson) {
        try {
            if (payloadJson == null || payloadJson.length() > 64_000) {
                respond(requestId, false, "{\"error\":{\"message\":\"INVALID_REQUEST\"}}");
                return;
            }
            JSONObject payload = new JSONObject(payloadJson);
            invokeOnMain(requestId, "NATIVE_ADMIN_RIDER_REWARDS_UNAVAILABLE", () -> {
                if (!valid(requestId, idToken)
                        || !"admin".equals(SavrivoFirebase.appRole(activity))) {
                    respond(requestId, false,
                            "{\"error\":{\"message\":\"INVALID_REQUEST\"}}");
                    return;
                }
                SavrivoCallableClient.getAdminRiderRewardsDashboard(activity, idToken, payload,
                        (success, json) -> respond(requestId, success, json));
            });
        } catch (Throwable error) {
            Log.e(TAG, "getAdminRiderRewardsDashboard bridge failed", error);
            respond(requestId, false,
                    "{\"error\":{\"message\":\"NATIVE_ADMIN_RIDER_REWARDS_UNAVAILABLE\"}}");
        }
    }

    @JavascriptInterface public void upsertRiderRewardCampaignPolicy(
            String requestId, String idToken, String payloadJson) {
        try {
            if (payloadJson == null || payloadJson.length() > 64_000) {
                respond(requestId, false, "{\"error\":{\"message\":\"INVALID_REQUEST\"}}");
                return;
            }
            JSONObject payload = new JSONObject(payloadJson);
            invokeOnMain(requestId, "NATIVE_RIDER_REWARD_POLICY_UNAVAILABLE", () -> {
                if (!valid(requestId, idToken)
                        || !"admin".equals(SavrivoFirebase.appRole(activity))) {
                    respond(requestId, false,
                            "{\"error\":{\"message\":\"INVALID_REQUEST\"}}");
                    return;
                }
                SavrivoCallableClient.upsertRiderRewardCampaignPolicy(activity, idToken, payload,
                        (success, json) -> respond(requestId, success, json));
            });
        } catch (Throwable error) {
            Log.e(TAG, "upsertRiderRewardCampaignPolicy bridge failed", error);
            respond(requestId, false,
                    "{\"error\":{\"message\":\"NATIVE_RIDER_REWARD_POLICY_UNAVAILABLE\"}}");
        }
    }

    @JavascriptInterface public void updateRiderRewardSettingsPolicy(
            String requestId, String idToken, String payloadJson) {
        try {
            if (payloadJson == null || payloadJson.length() > 64_000) {
                respond(requestId, false, "{\"error\":{\"message\":\"INVALID_REQUEST\"}}");
                return;
            }
            JSONObject payload = new JSONObject(payloadJson);
            invokeOnMain(requestId, "NATIVE_RIDER_REWARD_SETTINGS_UNAVAILABLE", () -> {
                if (!valid(requestId, idToken)
                        || !"admin".equals(SavrivoFirebase.appRole(activity))) {
                    respond(requestId, false,
                            "{\"error\":{\"message\":\"INVALID_REQUEST\"}}");
                    return;
                }
                SavrivoCallableClient.updateRiderRewardSettingsPolicy(activity, idToken, payload,
                        (success, json) -> respond(requestId, success, json));
            });
        } catch (Throwable error) {
            Log.e(TAG, "updateRiderRewardSettingsPolicy bridge failed", error);
            respond(requestId, false,
                    "{\"error\":{\"message\":\"NATIVE_RIDER_REWARD_SETTINGS_UNAVAILABLE\"}}");
        }
    }

    @JavascriptInterface public void getPlatformConfiguration(
            String requestId, String idToken, String payloadJson) {
        try {
            if (payloadJson == null || payloadJson.length() > 64_000) {
                respond(requestId, false, "{\"error\":{\"message\":\"INVALID_REQUEST\"}}");
                return;
            }
            JSONObject payload = new JSONObject(payloadJson);
            invokeOnMain(requestId, "NATIVE_PLATFORM_CONFIGURATION_UNAVAILABLE", () -> {
                if (!valid(requestId, idToken)
                        || !"admin".equals(SavrivoFirebase.appRole(activity))) {
                    respond(requestId, false,
                            "{\"error\":{\"message\":\"INVALID_REQUEST\"}}");
                    return;
                }
                SavrivoCallableClient.getPlatformConfiguration(activity, idToken, payload,
                        (success, json) -> respond(requestId, success, json));
            });
        } catch (Throwable error) {
            Log.e(TAG, "getPlatformConfiguration bridge failed", error);
            respond(requestId, false,
                    "{\"error\":{\"message\":\"NATIVE_PLATFORM_CONFIGURATION_UNAVAILABLE\"}}");
        }
    }

    @JavascriptInterface public void exportPlatformDataWorkbook(
            String requestId, String idToken, String payloadJson) {
        try {
            if (payloadJson == null || payloadJson.length() > 64_000) {
                respond(requestId, false, "{\"error\":{\"message\":\"INVALID_REQUEST\"}}");
                return;
            }
            JSONObject payload = new JSONObject(payloadJson);
            invokeOnMain(requestId, "NATIVE_DATA_EXPORT_UNAVAILABLE", () -> {
                if (!valid(requestId, idToken)
                        || !"admin".equals(SavrivoFirebase.appRole(activity))) {
                    respond(requestId, false,
                            "{\"error\":{\"message\":\"INVALID_REQUEST\"}}");
                    return;
                }
                SavrivoCallableClient.exportPlatformDataWorkbook(activity, idToken, payload,
                        (success, json) -> respond(requestId, success, json));
            });
        } catch (Throwable error) {
            Log.e(TAG, "exportPlatformDataWorkbook bridge failed", error);
            respond(requestId, false,
                    "{\"error\":{\"message\":\"NATIVE_DATA_EXPORT_UNAVAILABLE\"}}");
        }
    }

    @JavascriptInterface public void updatePlatformConfigurationPolicy(
            String requestId, String idToken, String payloadJson) {
        try {
            if (payloadJson == null || payloadJson.length() > 64_000) {
                respond(requestId, false, "{\"error\":{\"message\":\"INVALID_REQUEST\"}}");
                return;
            }
            JSONObject payload = new JSONObject(payloadJson);
            invokeOnMain(requestId, "NATIVE_PLATFORM_CONFIGURATION_UPDATE_UNAVAILABLE", () -> {
                if (!valid(requestId, idToken)
                        || !"admin".equals(SavrivoFirebase.appRole(activity))) {
                    respond(requestId, false,
                            "{\"error\":{\"message\":\"INVALID_REQUEST\"}}");
                    return;
                }
                SavrivoCallableClient.updatePlatformConfigurationPolicy(activity, idToken, payload,
                        (success, json) -> respond(requestId, success, json));
            });
        } catch (Throwable error) {
            Log.e(TAG, "updatePlatformConfigurationPolicy bridge failed", error);
            respond(requestId, false,
                    "{\"error\":{\"message\":\"NATIVE_PLATFORM_CONFIGURATION_UPDATE_UNAVAILABLE\"}}");
        }
    }

    @JavascriptInterface public void getRestaurantSettlementSummary(
            String requestId, String idToken, String payloadJson) {
        try {
            if (payloadJson == null || payloadJson.length() > 64_000) {
                respond(requestId, false, "{\"error\":{\"message\":\"INVALID_REQUEST\"}}");
                return;
            }
            JSONObject payload = new JSONObject(payloadJson);
            invokeOnMain(requestId, "NATIVE_RESTAURANT_FINANCE_UNAVAILABLE", () -> {
                String appRole = SavrivoFirebase.appRole(activity);
                if (!valid(requestId, idToken)
                        || !("restaurant".equals(appRole) || "admin".equals(appRole))) {
                    respond(requestId, false,
                            "{\"error\":{\"message\":\"INVALID_REQUEST\"}}");
                    return;
                }
                SavrivoCallableClient.getRestaurantSettlementSummary(activity, idToken, payload,
                        (success, json) -> respond(requestId, success, json));
            });
        } catch (Throwable error) {
            Log.e(TAG, "getRestaurantSettlementSummary bridge failed", error);
            respond(requestId, false,
                    "{\"error\":{\"message\":\"NATIVE_RESTAURANT_FINANCE_UNAVAILABLE\"}}");
        }
    }

    @JavascriptInterface public void claimRiderOrder(
            String requestId, String idToken, String orderId) {
        try {
            invokeOnMain(requestId, "NATIVE_RIDER_CLAIM_UNAVAILABLE", () -> {
                if (!valid(requestId, idToken)) {
                    respond(requestId, false, "{\"error\":{\"message\":\"INVALID_REQUEST\"}}");
                    return;
                }
                SavrivoCallableClient.claimRiderOrder(activity, idToken, orderId,
                        (success, json) -> respond(requestId, success, json));
            });
        } catch (Throwable error) {
            Log.e(TAG, "claimRiderOrder bridge failed", error);
            respond(requestId, false,
                    "{\"error\":{\"message\":\"NATIVE_RIDER_CLAIM_UNAVAILABLE\"}}");
        }
    }

    @JavascriptInterface public void declineRiderOrder(
            String requestId, String idToken, String orderId) {
        try {
            invokeOnMain(requestId, "NATIVE_RIDER_DECLINE_UNAVAILABLE", () -> {
                if (!valid(requestId, idToken)) {
                    respond(requestId, false, "{\"error\":{\"message\":\"INVALID_REQUEST\"}}");
                    return;
                }
                SavrivoCallableClient.declineRiderOrder(activity, idToken, orderId,
                        (success, json) -> respond(requestId, success, json));
            });
        } catch (Throwable error) {
            Log.e(TAG, "declineRiderOrder bridge failed", error);
            respond(requestId, false,
                    "{\"error\":{\"message\":\"NATIVE_RIDER_DECLINE_UNAVAILABLE\"}}");
        }
    }

    @JavascriptInterface public void markRiderArrivedRestaurant(
            String requestId, String idToken, String orderId) {
        try {
            invokeOnMain(requestId, "NATIVE_RIDER_ARRIVAL_UNAVAILABLE", () -> {
                if (!valid(requestId, idToken)
                        || !"rider".equals(SavrivoFirebase.appRole(activity))) {
                    respond(requestId, false, "{\"error\":{\"message\":\"INVALID_REQUEST\"}}");
                    return;
                }
                SavrivoCallableClient.markRiderArrivedRestaurant(activity, idToken, orderId,
                        (success, json) -> respond(requestId, success, json));
            });
        } catch (Throwable error) {
            Log.e(TAG, "markRiderArrivedRestaurant bridge failed", error);
            respond(requestId, false,
                    "{\"error\":{\"message\":\"NATIVE_RIDER_ARRIVAL_UNAVAILABLE\"}}");
        }
    }

    @JavascriptInterface public void startOrderAlarm(
            String alarmId, String title, String body, String orderId) {
        activity.runOnUiThread(() -> {
            if (!trustedPage.isTrusted() || !"restaurant".equals(SavrivoFirebase.appRole(activity))) return;
            OrderAlarmService.start(activity, alarmId, title, body, orderId);
        });
    }

    @JavascriptInterface public void stopOrderAlarm(String alarmId) {
        activity.runOnUiThread(() -> {
            if (!trustedPage.isTrusted() || !"restaurant".equals(SavrivoFirebase.appRole(activity))) return;
            OrderAlarmService.stop(activity, alarmId);
        });
    }

    @JavascriptInterface public void reconcileRestaurantOrderAlarms(String orderStateJson) {
        activity.runOnUiThread(() -> {
            if (!trustedPage.isTrusted()
                    || !"restaurant".equals(SavrivoFirebase.appRole(activity))
                    || orderStateJson == null || orderStateJson.length() > 128_000) return;
            try {
                JSONObject state = new JSONObject(orderStateJson);
                Set<String> knownOrderIds = validatedOrderIds(state.optJSONArray("known"));
                Set<String> pendingOrderIds = validatedOrderIds(state.optJSONArray("pending"));
                // Never let an incomplete/malformed pending list silence a known pending order.
                if (!knownOrderIds.containsAll(pendingOrderIds)) return;
                OrderAlarmService.reconcileRestaurantOrders(
                        activity, knownOrderIds, pendingOrderIds);
            } catch (Exception error) {
                Log.w(TAG, "Restaurant alarm reconciliation ignored malformed payload", error);
            }
        });
    }

    private static Set<String> validatedOrderIds(JSONArray values) {
        Set<String> orderIds = new HashSet<>();
        if (values == null) return orderIds;
        for (int index = 0; index < values.length() && index < 1_000; index++) {
            String orderId = values.optString(index, "");
            if (orderId.matches("[A-Za-z0-9_.:-]{1,120}")) orderIds.add(orderId);
        }
        return orderIds;
    }

    /**
     * Reject malformed money instructions at the trusted native boundary before they can reach
     * the callable. The backend remains authoritative and performs the same validation again.
     */
    private static boolean validCodRemittancePayload(JSONObject payload) {
        if (payload == null) return false;
        String operationId = payload.optString("operationId", "");
        String riderId = payload.optString("riderId", "");
        String method = payload.optString("method", "");
        String referenceId = payload.optString("referenceId", "");
        Object rawAmount = payload.opt("amountPaise");
        if (!(rawAmount instanceof Number)) return false;
        double amountDouble = ((Number) rawAmount).doubleValue();
        long amountPaise = ((Number) rawAmount).longValue();
        if (!Double.isFinite(amountDouble) || amountDouble != (double) amountPaise
                || amountPaise <= 0L || amountPaise > 1_000_000_000L) return false;
        if (!operationId.matches("[A-Za-z0-9][A-Za-z0-9._:-]{15,127}")
                || !riderId.matches("[A-Za-z0-9_.:-]{1,120}")) return false;
        if (!("cash_deposit".equals(method) || "bank_transfer".equals(method)
                || "upi".equals(method))) return false;
        if (!referenceId.isEmpty()
                && !referenceId.matches("[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}")) return false;
        return "cash_deposit".equals(method) || !referenceId.isEmpty();
    }

    @JavascriptInterface public void dismissRiderOffer(String orderId) {
        activity.runOnUiThread(() -> {
            if (!trustedPage.isTrusted() || !"rider".equals(SavrivoFirebase.appRole(activity))
                    || orderId == null || !orderId.matches("[A-Za-z0-9_.:-]{1,120}")) return;
            NotificationManager manager = activity.getSystemService(NotificationManager.class);
            if (manager != null) {
                manager.cancel(SavrivoNotifications.stableId("rider-offer", orderId));
            }
            OrderAlarmService.stop(activity, "rider-offer:" + orderId);
            SavrivoPushStore.removeRiderOffer(activity, orderId);
        });
    }

    @JavascriptInterface public void pauseRiderOffer(String orderId) {
        activity.runOnUiThread(() -> {
            if (!trustedPage.isTrusted() || !"rider".equals(SavrivoFirebase.appRole(activity))
                    || orderId == null || !orderId.matches("[A-Za-z0-9_.:-]{1,120}")) return;
            NotificationManager manager = activity.getSystemService(NotificationManager.class);
            if (manager != null) {
                manager.cancel(SavrivoNotifications.stableId("rider-offer", orderId));
            }
            OrderAlarmService.pause(activity, "rider-offer:" + orderId);
        });
    }

    @JavascriptInterface public void startRiderOffer(
            String orderId, String title, String body, long expiresAt, long offeredAt) {
        activity.runOnUiThread(() -> {
            if (!trustedPage.isTrusted() || !"rider".equals(SavrivoFirebase.appRole(activity))
                    || orderId == null || !orderId.matches("[A-Za-z0-9_.:-]{1,120}")
                    || expiresAt <= System.currentTimeMillis()) return;
            OrderAlarmService.start(activity, "rider-offer:" + orderId,
                    title == null ? "New delivery offer" : title,
                    body == null ? "Accept or decline this nearby delivery." : body,
                    orderId, offeredAt, expiresAt);
        });
    }

    private boolean valid(String requestId, String idToken) {
        return trustedPage.isTrusted()
                && requestId != null && requestId.matches("[A-Za-z0-9_-]{1,80}")
                && idToken != null && idToken.length() >= 32 && idToken.length() <= 16_384
                && idToken.matches("[A-Za-z0-9._~-]+");
    }

    private void requestNotificationPermission() {
        if (Build.VERSION.SDK_INT < 33
                || activity.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)
                == PackageManager.PERMISSION_GRANTED) return;
        activity.runOnUiThread(() -> {
            if (trustedPage.isTrusted()) {
                activity.requestPermissions(
                        new String[]{Manifest.permission.POST_NOTIFICATIONS},
                        NOTIFICATION_PERMISSION_REQUEST);
            }
        });
    }

    /**
     * Android invokes {@link JavascriptInterface} methods on its Java bridge worker thread.
     * Firebase Android SDK entry points are lifecycle-aware and must be started from the main
     * thread. Posting every cloud operation here also gives all four apps one consistent bridge
     * boundary instead of leaving individual actions vulnerable to a synchronous SDK failure.
     */
    private void invokeOnMain(String requestId, String failureCode, Runnable action) {
        activity.runOnUiThread(() -> {
            if (!trustedPage.isTrusted() || activity.isFinishing()
                    || (Build.VERSION.SDK_INT >= 17 && activity.isDestroyed())) {
                respond(requestId, false,
                        "{\"error\":{\"message\":\"NATIVE_ACTIVITY_UNAVAILABLE\"}}");
                return;
            }
            try {
                action.run();
            } catch (Throwable error) {
                Log.e(TAG, failureCode, error);
                respond(requestId, false, "{\"error\":{\"message\":"
                        + JSONObject.quote(failureCode) + "}}");
            }
        });
    }

    private void respond(String requestId, boolean success, String json) {
        String safeJson = normalizeJson(json);
        String script = "window.SavrivoNativeCallbacks&&window.SavrivoNativeCallbacks.resolve("
                + JSONObject.quote(requestId) + "," + success + "," + safeJson + ")";
        activity.runOnUiThread(() -> {
            if (trustedPage.isTrusted() && webView != null) {
                webView.evaluateJavascript(script, null);
            }
        });
    }

    private static String normalizeJson(String json) {
        if (json == null || json.length() == 0 || json.length() > 300_000) return "null";
        try { return new JSONObject("{\"v\":" + json + "}").get("v") == null ? "null" : json; }
        catch (Exception ignored) { return JSONObject.quote(json); }
    }
}
