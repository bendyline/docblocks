package com.bendyline.docblocks.mobile;

import android.app.Activity;
import android.os.Handler;
import android.os.Looper;
import androidx.core.splashscreen.SplashScreen;

/**
 * Holds Android's launch splash (the brown and the D of the splash theme) over
 * the app until the page reports that startup has settled, so launch goes from
 * the splash straight to the restored document. Released early it reveals
 * index.html's splash — the same brown and mark — which is what shows behind
 * the first-run storage question.
 */
final class LaunchSplash {
    private LaunchSplash() {}

    /** A page that never reports (a failed load) still gets the screen by then. */
    private static final long FAILSAFE_MS = 10_000;

    private static volatile boolean held;

    /** Call before the activity's super.onCreate. */
    static void install(Activity activity) {
        held = true;
        SplashScreen.installSplashScreen(activity).setKeepOnScreenCondition(() -> held);
        new Handler(Looper.getMainLooper()).postDelayed(LaunchSplash::release, FAILSAFE_MS);
    }

    static boolean isHeld() {
        return held;
    }

    static void release() {
        held = false;
    }
}
