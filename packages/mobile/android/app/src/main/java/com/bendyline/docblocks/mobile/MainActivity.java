package com.bendyline.docblocks.mobile;
import android.os.Bundle;
import com.getcapacitor.BridgeActivity;
public class MainActivity extends BridgeActivity {
    static final int MAX_INCOMING = 8, MAX_SHARED_TEXT_CHARS = 256 * 1024;
    static final java.util.ArrayDeque<android.net.Uri> incoming = new java.util.ArrayDeque<>();
    /** Text shared from another app (a link, a passage) with its subject, which may be null. */
    static final java.util.ArrayDeque<String[]> sharedText = new java.util.ArrayDeque<>();
    /** Files and texts together stay within what one open-request batch carries (mobile-wire.ts). */
    private static boolean roomForMore() { return incoming.size() + sharedText.size() < MAX_INCOMING; }
    private static void incoming(android.net.Uri uri) {
        if (uri != null && "content".equals(uri.getScheme()) && roomForMore()) incoming.add(uri);
    }
    @SuppressWarnings("deprecation") // The typed getters need API 33; minSdk is 28.
    private void receive(android.content.Intent intent) {
        if (intent == null) return;
        String action = intent.getAction();
        if (android.content.Intent.ACTION_VIEW.equals(action)) incoming(intent.getData());
        else if (android.content.Intent.ACTION_SEND.equals(action)) {
            Object stream = intent.getParcelableExtra(android.content.Intent.EXTRA_STREAM);
            if (stream instanceof android.net.Uri) { incoming((android.net.Uri)stream); return; }
            CharSequence text = intent.getCharSequenceExtra(android.content.Intent.EXTRA_TEXT);
            CharSequence subject = intent.getCharSequenceExtra(android.content.Intent.EXTRA_SUBJECT);
            if (text != null && text.toString().trim().length() > 0 && text.length() <= MAX_SHARED_TEXT_CHARS && roomForMore())
                sharedText.add(new String[]{ subject == null ? null : subject.toString(), text.toString() });
        } else if (android.content.Intent.ACTION_SEND_MULTIPLE.equals(action)) {
            java.util.ArrayList<android.os.Parcelable> streams = intent.getParcelableArrayListExtra(android.content.Intent.EXTRA_STREAM);
            if (streams != null) for (android.os.Parcelable stream : streams) if (stream instanceof android.net.Uri) incoming((android.net.Uri)stream);
        }
    }
    @Override protected void onNewIntent(android.content.Intent intent) { super.onNewIntent(intent); receive(intent); if (!incoming.isEmpty() || !sharedText.isEmpty()) getBridge().eval("window.dispatchEvent(new Event('docblocksIncoming'))", null); }
    @Override public void onCreate(Bundle savedInstanceState) {
        LaunchSplash.install(this);
        registerPlugin(DocBlocksMobilePlugin.class);
        BundledEmbeddingModel.install(this);
        super.onCreate(savedInstanceState);
        // A rebuilt activity, or one reopened from Recents, carries the intent it
        // was first started with; taking it again would import the share twice.
        if (savedInstanceState == null && getIntent() != null
            && (getIntent().getFlags() & android.content.Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY) == 0) receive(getIntent());
        BridgeBoundary.install(getBridge());
        SystemInsets.install(this);
        // Android paints a stretched gray play button under any <video> with no poster
        // and no decoded frame yet; a transparent default lets the page show through.
        getBridge().getWebView().setWebChromeClient(new com.getcapacitor.BridgeWebChromeClient(getBridge()) {
            @Override public android.graphics.Bitmap getDefaultVideoPoster() { return android.graphics.Bitmap.createBitmap(1, 1, android.graphics.Bitmap.Config.ARGB_8888); }
        });
        getOnBackPressedDispatcher().addCallback(this, new androidx.activity.OnBackPressedCallback(true) {
            @Override public void handleOnBackPressed() { getBridge().eval("window.dispatchEvent(new Event('docblocksNativeBack'))", null); }
        });
    }
}
