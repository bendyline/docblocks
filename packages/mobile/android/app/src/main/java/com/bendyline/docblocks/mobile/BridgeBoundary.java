package com.bendyline.docblocks.mobile;

import android.net.Uri;
import android.webkit.WebResourceRequest;
import android.webkit.WebView;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;
import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeWebViewClient;
import com.getcapacitor.MessageHandler;
import java.util.Collections;

/** Only the packaged top-level editor can call native code, including core Capacitor plugins. */
public final class BridgeBoundary {
    private BridgeBoundary() {}
    private static boolean packaged(Uri url) {
        return url != null && "https".equals(url.getScheme()) && "localhost".equals(url.getHost()) && url.getPort() == -1 && ("/".equals(url.getPath()) || "/index.html".equals(url.getPath()));
    }
    public static void install(Bridge bridge) {
        WebView view = bridge.getWebView();
        view.removeJavascriptInterface("androidBridge");
        view.removeJavascriptInterface("CapacitorCookiesAndroidInterface");
        view.removeJavascriptInterface("CapacitorHttpAndroidInterface");
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) throw new IllegalStateException("Update Android System WebView to open DocBlocks.");
        WebViewCompat.removeWebMessageListener(view, "androidBridge");
        MessageHandler dispatcher = new MessageHandler(bridge, view, null);
        WebViewCompat.removeWebMessageListener(view, "androidBridge");
        view.removeJavascriptInterface("androidBridge");
        WebViewCompat.addWebMessageListener(view, "androidBridge", Collections.singleton("https://localhost"), (sender, message, origin, mainFrame, reply) -> {
            if (!mainFrame || !"https".equals(origin.getScheme()) || !"localhost".equals(origin.getHost()) || !packaged(Uri.parse(sender.getUrl() == null ? "" : sender.getUrl()))) return;
            try {
                String type = new org.json.JSONObject(message.getData()).optString("type");
                if (!type.isEmpty() && !type.equals("js.error")) return;
            } catch (Exception error) { return; }
            dispatcher.postMessage(message.getData());
        });
        bridge.setWebViewClient(new BridgeWebViewClient(bridge) {
            @Override public boolean shouldOverrideUrlLoading(WebView webView, WebResourceRequest request) {
                if (request.isForMainFrame()) {
                    if (packaged(request.getUrl())) return false;
                    // External links go through host.shell.openExternal's exact HTTP URL policy.
                    return true;
                }
                return !"about".equals(request.getUrl().getScheme()) && !"blob".equals(request.getUrl().getScheme());
            }
        });
    }
}
