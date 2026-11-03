package com.bendyline.docblocks.mobile;
import android.os.Bundle;
import com.getcapacitor.BridgeActivity;
public class MainActivity extends BridgeActivity {
    static final java.util.ArrayDeque<android.net.Uri> incoming = new java.util.ArrayDeque<>();
    private void receive(android.content.Intent intent) {
        if (intent != null && android.content.Intent.ACTION_VIEW.equals(intent.getAction()) && intent.getData() != null && "content".equals(intent.getData().getScheme()) && incoming.size() < 8) incoming.add(intent.getData());
    }
    @Override protected void onNewIntent(android.content.Intent intent) { super.onNewIntent(intent); receive(intent); if (!incoming.isEmpty()) getBridge().eval("window.dispatchEvent(new Event('docblocksIncoming'))", null); }
    @Override public void onCreate(Bundle savedInstanceState) {
        registerPlugin(DocBlocksMobilePlugin.class);
        super.onCreate(savedInstanceState);
        receive(getIntent());
        BridgeBoundary.install(getBridge());
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
