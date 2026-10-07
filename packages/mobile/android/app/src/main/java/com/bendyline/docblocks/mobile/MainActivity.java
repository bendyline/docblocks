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
        getOnBackPressedDispatcher().addCallback(this, new androidx.activity.OnBackPressedCallback(true) {
            @Override public void handleOnBackPressed() { getBridge().eval("window.dispatchEvent(new Event('docblocksNativeBack'))", null); }
        });
    }
}
