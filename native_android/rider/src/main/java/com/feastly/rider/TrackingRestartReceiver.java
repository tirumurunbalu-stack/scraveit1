package com.feastly.rider;

import android.Manifest;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;
import android.util.Log;

/**
 * Brings an online rider back after a phone restart, an app update or a wake-up push from dispatch.
 * Android only gives a service started this way its location when "Allow all the time" is granted.
 * Going offline clears the saved session, so a rider who went offline is never brought back.
 */
public class TrackingRestartReceiver extends BroadcastReceiver {
    private static final String TAG = "TrackingRestart";

    @Override public void onReceive(Context context, Intent intent) {
        if (!TrackingService.hasStoredSession(context) || TrackingService.isRunning()) return;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q
                && context.checkSelfPermission(Manifest.permission.ACCESS_BACKGROUND_LOCATION)
                    != PackageManager.PERMISSION_GRANTED) {
            Log.i(TAG, "TRACKING_RESTART_NEEDS_ALL_THE_TIME");
            return;
        }
        Intent service = new Intent(context, TrackingService.class);
        service.setAction(TrackingService.ACTION_RESTORE);
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) context.startForegroundService(service);
            else context.startService(service);
            Log.i(TAG, "TRACKING_RESTARTED from " + intent.getAction());
        } catch (RuntimeException error) {
            Log.w(TAG, "TRACKING_RESTART_REFUSED", error);
        }
    }
}
