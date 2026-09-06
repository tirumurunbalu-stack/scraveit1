package com.savrivo.firebase;

import android.app.Application;

public final class SavrivoApplication extends Application {
    @Override public void onCreate() {
        super.onCreate();
        SavrivoFirebase.ensureInitialized(this);
        SavrivoNotifications.createChannels(this);
    }
}
