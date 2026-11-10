package com.bendyline.docblocks.mobile;

import android.app.Activity;
import android.os.Build;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;

/**
 * Keeps the WebView clear of the system bars and the keyboard by padding the
 * window once, natively, for every Android and WebView version.
 *
 * Capacitor's SystemBars inset handling (turned off in capacitor.config.ts)
 * has two branches, and on a WebView of 140 or later it takes the one that
 * passes the bar insets on to the page, assuming the window is edge-to-edge.
 * Before Android 15 it is not: the framework's `fitsSystemWindows` content
 * root pads those insets a second time, so with the keyboard up the
 * navigation bar was counted twice and a bar-high gap opened above the
 * keyboard (Galaxy S20 FE, Android 13, WebView 155). It also never hands the
 * keyboard inset off, so Chromium can shrink the page for a keyboard the view
 * already clears.
 *
 * Here the decor view takes all of it as padding — bars on every edge, the
 * keyboard at the bottom — and passes zeroed insets down the tree, so nothing
 * below applies them again. The page never draws under the bars, so its
 * `env(safe-area-inset-*)` stay 0 and the bars show the window background,
 * which styles.xml matches to the editor chrome.
 */
final class SystemInsets {
    private SystemInsets() {}

    private static final int BARS = WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout();

    static void install(Activity activity) {
        ViewCompat.setOnApplyWindowInsetsListener(activity.getWindow().getDecorView(), (view, insets) -> {
            Insets bars = insets.getInsets(BARS);
            // Before Android 11, adjustResize has already shrunk the window for
            // the keyboard, while the compat keyboard inset still reports its
            // full height; padding for it there would count it twice.
            int keyboard = Build.VERSION.SDK_INT >= Build.VERSION_CODES.R
                ? insets.getInsets(WindowInsetsCompat.Type.ime()).bottom
                : 0;
            // The keyboard inset is measured from the screen's bottom edge, so it
            // already covers the navigation bar beneath the keyboard.
            view.setPadding(bars.left, bars.top, bars.right, Math.max(bars.bottom, keyboard));
            // Zeroed rather than CONSUMED: consuming stops the WebView recomputing
            // its safe-area values when the insets next change
            // (https://issues.chromium.org/issues/461332423).
            return new WindowInsetsCompat.Builder(insets)
                .setInsets(BARS | WindowInsetsCompat.Type.ime(), Insets.NONE)
                .build();
        });
        ViewCompat.requestApplyInsets(activity.getWindow().getDecorView());
    }
}
