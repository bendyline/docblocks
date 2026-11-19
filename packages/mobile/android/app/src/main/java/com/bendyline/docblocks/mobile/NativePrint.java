package com.bendyline.docblocks.mobile;

import android.app.Activity;
import android.content.Context;
import android.net.Uri;
import android.os.Bundle;
import android.os.CancellationSignal;
import android.os.ParcelFileDescriptor;
import android.print.PageRange;
import android.print.PrintAttributes;
import android.print.PrintDocumentAdapter;
import android.print.PrintJob;
import android.print.PrintManager;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import com.getcapacitor.Bridge;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;

/**
 * The system print dialog for the page's print() (print.ts): Android WebView ignores
 * window.print(). Call on the UI thread.
 */
final class NativePrint {
    private NativePrint() {}

    interface Closed { void run(boolean printed); }
    interface Failed { void run(Exception error); }

    private static final String STAGED_ADDRESS = "https://localhost/__docblocks-print.html";
    /** The staged page's WebView, kept alive until its dialog closes. */
    private static WebView staged;

    /** Prints `view` under its print styles; `closed` runs when the dialog closes. */
    static void print(Activity activity, WebView view, String jobName, Closed closed) {
        PrintManager manager = (PrintManager) activity.getSystemService(Context.PRINT_SERVICE);
        PrintDocumentAdapter adapter = view.createPrintDocumentAdapter(jobName);
        PrintJob[] job = new PrintJob[1];
        job[0] = manager.print(jobName, new PrintDocumentAdapter() {
            @Override public void onStart() { adapter.onStart(); }
            @Override public void onLayout(PrintAttributes oldAttributes, PrintAttributes newAttributes, CancellationSignal cancellation, LayoutResultCallback callback, Bundle extras) {
                adapter.onLayout(oldAttributes, newAttributes, cancellation, callback, extras);
            }
            @Override public void onWrite(PageRange[] pages, ParcelFileDescriptor destination, CancellationSignal cancellation, WriteResultCallback callback) {
                adapter.onWrite(pages, destination, cancellation, callback);
            }
            @Override public void onFinish() {
                adapter.onFinish();
                closed.run(job[0] != null && !job[0].isCancelled() && !job[0].isFailed());
            }
        }, new PrintAttributes.Builder().build());
    }

    /**
     * Loads a staged page in a WebView of its own, then prints it. The editor shows its text
     * documents in a frame, and WebView prints only a top-level page. JavaScript is off; the
     * app's own files (fonts, icons) load as the editor's frame loaded them.
     */
    static void printStaged(Activity activity, Bridge bridge, Path page, String jobName, Closed closed, Failed failed) {
        if (staged != null) release(staged);
        WebView view = new WebView(activity);
        staged = view;
        WebSettings settings = view.getSettings();
        settings.setJavaScriptEnabled(false);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        view.setWebViewClient(new WebViewClient() {
            private boolean settled;
            @Override public WebResourceResponse shouldInterceptRequest(WebView webView, WebResourceRequest request) {
                Uri url = request.getUrl();
                if (STAGED_ADDRESS.equals(url.toString())) {
                    try { return new WebResourceResponse("text/html", "utf-8", Files.newInputStream(page)); }
                    catch (IOException e) { return new WebResourceResponse("text/plain", "utf-8", 404, "Not Found", null, null); }
                }
                if ("https".equals(url.getScheme()) && "localhost".equals(url.getHost())) return bridge.getLocalServer().shouldInterceptRequest(request);
                return null;
            }
            /** The staged page only; its links never navigate anywhere. */
            @Override public boolean shouldOverrideUrlLoading(WebView webView, WebResourceRequest request) { return true; }
            @Override public void onPageFinished(WebView webView, String url) {
                if (settled) return;
                settled = true;
                try {
                    print(activity, webView, jobName, printed -> { release(webView); closed.run(printed); });
                } catch (RuntimeException e) { release(webView); failed.run(e); }
            }
            @Override public void onReceivedError(WebView webView, WebResourceRequest request, WebResourceError error) {
                if (settled || !request.isForMainFrame()) return;
                settled = true;
                release(webView);
                failed.run(new IOException(String.valueOf(error.getDescription())));
            }
        });
        view.loadUrl(STAGED_ADDRESS);
    }

    /** Destroyed after the callback that releases it returns, never inside it. */
    private static void release(WebView view) {
        if (staged == view) staged = null;
        new android.os.Handler(android.os.Looper.getMainLooper()).post(view::destroy);
    }
}
