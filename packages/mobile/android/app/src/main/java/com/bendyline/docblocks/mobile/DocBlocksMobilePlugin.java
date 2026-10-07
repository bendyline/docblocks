package com.bendyline.docblocks.mobile;

import android.app.Activity;
import androidx.activity.result.ActivityResult;
import androidx.core.content.FileProvider;
import com.getcapacitor.annotation.ActivityCallback;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import com.getcapacitor.*;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.nio.file.*;
import java.util.*;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.RejectedExecutionException;

@CapacitorPlugin(name = "DocBlocksMobile")
public class DocBlocksMobilePlugin extends Plugin {
    private Storage storage;
    private WorkspaceRegistry registry;
    private boolean pickingFolder;
    private ExportStaging exportStaging;
    private String exportToken;
    private Path exportPath;
    private final ExecutorService queue = new ThreadPoolExecutor(1, 1, 0, TimeUnit.MILLISECONDS, new ArrayBlockingQueue<>(32));
    private void submit(PluginCall call, Runnable action) {
        try { queue.execute(action); }
        catch (RejectedExecutionException error) { call.reject("Device storage is busy. Try again."); }
    }
    @Override public void load() {
        try {
            Path root = getContext().getFilesDir().toPath().resolve("Workspace"); Files.createDirectories(root);
            storage = new Storage(Collections.singletonMap("local", root));
            registry = new WorkspaceRegistry(getContext()); registry.restore(storage);
            exportStaging = new ExportStaging(getContext().getCacheDir().toPath().resolve("DocBlocksExports"));
        } catch (Exception ignored) { /* bootstrap surfaces startup failure, never a replacement workspace. */ }
    }
    @Override protected void handleOnDestroy() { queue.shutdown(); if (storage != null) storage.shutdown(); }
    @PluginMethod public void bootstrap(PluginCall call) {
        if (call.getData().length() != 0 || storage == null || registry == null || exportStaging == null) { call.reject("Device storage could not be opened."); return; }
        try {
            String version = getContext().getPackageManager().getPackageInfo(getContext().getPackageName(), 0).versionName;
            org.json.JSONArray workspaces = new org.json.JSONArray().put(Storage.object("id", "local", "name", "On this device", "rootPath", "On this device / DocBlocks"));
            org.json.JSONArray granted = registry.list(); for (int index = 0; index < granted.length(); index++) workspaces.put(granted.get(index));
            call.resolve(JSObject.fromJSONObject(Storage.object("env", Storage.object("surface", "capacitor", "surfaceLabel", "Android", "platform", "android", "appVersion", version, "isDev", false), "workspaces", workspaces, "folderPicker", true, "capabilities", Storage.capabilities())));
        } catch (Exception e) { call.reject("Device storage could not be opened."); }
    }
    @PluginMethod public void request(PluginCall call) {
        JSObject input = call.getObject("request"); if (call.getData().length() != 1 || input == null || storage == null) { call.reject("Invalid storage request."); return; }
        submit(call, () -> { try { call.resolve(JSObject.fromJSONObject(storage.request(input))); } catch (Exception e) { call.reject("Invalid native storage response."); } });
    }
    @PluginMethod public void openExternal(PluginCall call) {
        String value = call.getString("url");
        try {
            if (call.getData().length() != 1 || value == null || value.length() > 8192 || value.indexOf('\\') >= 0) throw new IllegalArgumentException();
            java.net.URI uri = new java.net.URI(value);
            if (!Arrays.asList("https", "http").contains(uri.getScheme()) || uri.getHost() == null || uri.getUserInfo() != null || !uri.toASCIIString().equals(value)) throw new IllegalArgumentException();
            getActivity().startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(value))); call.resolve();
        } catch (Exception e) { call.reject("The link could not be opened."); }
    }
    @PluginMethod public void pickFolder(PluginCall call) {
        if (call.getData().length() != 0 || pickingFolder || exportToken != null) { call.reject("Close the current picker first."); return; }
        pickingFolder = true;
        Intent picker = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION | Intent.FLAG_GRANT_PREFIX_URI_PERMISSION);
        getActivity().runOnUiThread(() -> { try { startActivityForResult(call, picker, "folderResult"); } catch (Exception e) { pickingFolder = false; call.reject("The folder picker could not be opened."); } });
    }
    @ActivityCallback private void folderResult(PluginCall call, ActivityResult result) {
        pickingFolder = false; if (call == null) return;
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null || result.getData().getData() == null) { call.resolve(new JSObject().put("workspace", org.json.JSONObject.NULL)); return; }
        submit(call, () -> {
            try { call.resolve(new JSObject().put("workspace", registry.add(result.getData().getData(), result.getData().getFlags(), storage))); }
            catch (Exception e) { call.reject("The folder could not be opened.", e); }
        });
    }
    @PluginMethod public void forgetFolder(PluginCall call) {
        String id = call.getString("workspaceId");
        if (call.getData().length() != 1 || id == null || !id.matches("[a-fA-F0-9-]{36}")) { call.reject("The device workspace cannot be removed."); return; }
        submit(call, () -> { try { registry.remove(id, storage); call.resolve(); } catch (Exception e) { call.reject("The workspace could not be removed.", e); } });
    }
    @PluginMethod public void takeOpenRequests(PluginCall call) {
        if (call.getData().length() != 0 || storage == null) { call.reject("Invalid import request."); return; }
        getActivity().runOnUiThread(() -> {
            java.util.List<Uri> sources = new java.util.ArrayList<>(MainActivity.incoming); MainActivity.incoming.clear();
            submit(call, () -> {
                try {
                    org.json.JSONArray requests = new org.json.JSONArray();
                    for (Uri source : sources) {
                        String name;
                        try (android.database.Cursor cursor = getContext().getContentResolver().query(source, new String[]{android.provider.OpenableColumns.DISPLAY_NAME}, null, null, null)) {
                            if (cursor == null || !cursor.moveToFirst()) throw new java.io.IOException("Document unavailable"); name = cursor.getString(0);
                        }
                        try (java.io.InputStream stream = getContext().getContentResolver().openInputStream(source)) {
                            if (stream == null) throw new java.io.IOException("Document unavailable");
                            String path = storage.importDocument(name, stream);
                            requests.put(Storage.object("kind", "workspace-file", "workspaceId", "local", "path", "/" + path));
                        }
                    }
                    call.resolve(new JSObject().put("requests", requests));
                } catch (Exception e) { call.reject("The document could not be imported. The original file was not changed.", e); }
            });
        });
    }
    @PluginMethod public void exportFile(PluginCall call) {
        JSObject request = call.getObject("request");
        if (call.getData().length() != 1 || request == null || exportStaging == null) { call.reject("Invalid export request."); return; }
        submit(call, () -> {
            try {
                String op = requiredString(request, "op", 16);
                switch (op) {
                case "begin":
                    keys(request, "op", "filename", "byteLength");
                    String token = exportStaging.begin(requiredString(request, "filename", 255), requiredNumber(request, "byteLength", Storage.FILE_BYTES));
                    call.resolve(new JSObject().put("transferId", token)); break;
                case "append":
                    keys(request, "op", "transferId", "offset", "data");
                    exportStaging.append(requiredString(request, "transferId", 256), requiredNumber(request, "offset", Storage.FILE_BYTES), requiredString(request, "data", ((Storage.CHUNK_BYTES + 2) / 3) * 4)); call.resolve(); break;
                case "cancel":
                    keys(request, "op", "transferId");
                    String id = requiredString(request, "transferId", 256); if (id.equals(exportToken)) throw new IllegalStateException("Picker is active"); exportStaging.cancel(id); call.resolve(); break;
                case "finish":
                    keys(request, "op", "transferId", "action");
                    if (exportToken != null || pickingFolder) throw new IllegalStateException("Picker is active");
                    String transfer = requiredString(request, "transferId", 256), action = requiredString(request, "action", 8);
                    if (!Arrays.asList("save", "share").contains(action)) throw new IllegalArgumentException();
                    Path path = exportStaging.finish(transfer);
                    if (action.equals("share")) {
                        Uri uri = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", path.toFile());
                        Intent intent = new Intent(Intent.ACTION_SEND).setType(mime(path)).putExtra(Intent.EXTRA_STREAM, uri).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                        intent.setClipData(ClipData.newRawUri("DocBlocks export", uri));
                        getActivity().runOnUiThread(() -> {
                            try { getActivity().startActivity(Intent.createChooser(intent, "Share file")); call.resolve(new JSObject().put("outcome", "presented")); }
                            catch (Exception e) { call.reject("The share sheet could not be opened."); }
                        });
                        // Receiving apps may read after the sheet closes. Only this export survives, for 24 hours.
                        exportStaging.retainForShare(transfer);
                    } else {
                        exportToken = transfer; exportPath = path;
                        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType(mime(path)).putExtra(Intent.EXTRA_TITLE, path.getFileName().toString());
                        getActivity().runOnUiThread(() -> { try { startActivityForResult(call, intent, "exportResult"); } catch (Exception e) { exportToken = null; exportPath = null; call.reject("The save picker could not be opened."); } });
                    }
                    break;
                default: throw new IllegalArgumentException();
                }
            } catch (Exception e) { call.reject("The export could not be completed.", e); }
        });
    }
    @ActivityCallback private void exportResult(PluginCall call, ActivityResult result) {
        if (call == null) return;
        final Path source = exportPath; exportPath = null; exportToken = null;
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null || result.getData().getData() == null) { call.resolve(new JSObject().put("outcome", "cancelled")); return; }
        Uri destination = result.getData().getData();
        submit(call, () -> {
            try (java.io.InputStream input = Files.newInputStream(source); java.io.OutputStream output = getContext().getContentResolver().openOutputStream(destination, "wt")) {
                if (output == null) throw new java.io.IOException("Destination unavailable");
                byte[] chunk = new byte[Storage.CHUNK_BYTES]; int count; while ((count = input.read(chunk)) != -1) output.write(chunk, 0, count); output.flush();
            } catch (Exception e) { call.reject("The file could not be saved.", e); return; }
            call.resolve(new JSObject().put("outcome", "saved"));
        });
    }
    private static String mime(Path path) {
        String type = android.webkit.MimeTypeMap.getSingleton().getMimeTypeFromExtension(path.getFileName().toString().replaceFirst("^.*\\.", "").toLowerCase(Locale.ROOT));
        return type == null ? "application/octet-stream" : type;
    }
    private static void keys(JSObject value, String... keys) {
        Set<String> expected = new HashSet<>(Arrays.asList(keys));
        if (value.length() != expected.size()) throw new IllegalArgumentException();
        Iterator<String> iterator = value.keys(); while (iterator.hasNext()) if (!expected.contains(iterator.next())) throw new IllegalArgumentException();
    }
    private static String requiredString(JSObject value, String key, int max) {
        Object raw = value.opt(key); if (!(raw instanceof String) || ((String)raw).length() > max || ((String)raw).indexOf(0) >= 0) throw new IllegalArgumentException(); return (String)raw;
    }
    private static int requiredNumber(JSObject value, String key, int max) {
        Object raw = value.opt(key); if (!(raw instanceof Number)) throw new IllegalArgumentException(); double number = ((Number)raw).doubleValue();
        if (!Double.isFinite(number) || number != Math.rint(number) || number < 0 || number > max) throw new IllegalArgumentException(); return (int)number;
    }
    @PluginMethod public void backUnhandled(PluginCall call) {
        if (call.getData().length() != 0) { call.reject("Invalid Back request."); return; }
        getActivity().runOnUiThread(() -> { getActivity().moveTaskToBack(true); call.resolve(); });
    }
    @PluginMethod public void writeText(PluginCall call) {
        String text = call.getString("text"); if (call.getData().length() != 1 || text == null || text.length() > 20 * 1024 * 1024) { call.reject("Invalid clipboard text."); return; }
        ClipboardManager clipboard = (ClipboardManager)getContext().getSystemService(Context.CLIPBOARD_SERVICE);
        clipboard.setPrimaryClip(ClipData.newPlainText("DocBlocks", text)); call.resolve();
    }
}
