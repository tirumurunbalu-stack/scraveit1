package com.savrivo.firebase;

import android.app.Activity;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.webkit.WebView;

import androidx.core.content.ContextCompat;

/** Delivers queued FCM data events exactly through the already trusted local WebView. */
public final class SavrivoWebPushBinder {
    private final Activity activity;
    private final WebView webView;
    private final SavrivoOperationsBridge.TrustedPage trustedPage;
    private boolean registered;

    private final BroadcastReceiver receiver = new BroadcastReceiver() {
        @Override public void onReceive(Context context, Intent intent) {
            publishPending();
        }
    };

    public SavrivoWebPushBinder(
            Activity activity, WebView webView, SavrivoOperationsBridge.TrustedPage trustedPage) {
        this.activity = activity;
        this.webView = webView;
        this.trustedPage = trustedPage;
    }

    public void onStart() {
        if (registered) return;
        IntentFilter filter = new IntentFilter(SavrivoPushStore.ACTION_PUSH);
        ContextCompat.registerReceiver(
                activity, receiver, filter, ContextCompat.RECEIVER_NOT_EXPORTED);
        registered = true;
        publishPending();
    }

    public void onStop() {
        if (!registered) return;
        try { activity.unregisterReceiver(receiver); }
        catch (Exception ignored) { }
        registered = false;
    }

    public void onPageReady() { publishPending(); }

    public void onNewIntent(Intent intent) {
        org.json.JSONObject event = SavrivoPushStore.eventFromIntent(intent);
        if (event != null) SavrivoPushStore.dispatch(activity, event);
        publishPending();
    }

    public void publishPending() {
        if (!trustedPage.isTrusted()) return;
        String events = SavrivoPushStore.takePending(activity);
        if ("[]".equals(events)) return;
        String script = "window.SavrivoNativePushBatch&&window.SavrivoNativePushBatch(" + events + ")";
        activity.runOnUiThread(() -> {
            if (trustedPage.isTrusted()) webView.evaluateJavascript(script, null);
        });
    }

    public void close() { onStop(); }
}
