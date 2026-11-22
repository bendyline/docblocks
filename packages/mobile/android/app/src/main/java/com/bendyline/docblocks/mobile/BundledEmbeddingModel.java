package com.bendyline.docblocks.mobile;

import android.content.Context;
import android.content.res.AssetManager;
import android.util.AtomicFile;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.Iterator;
import java.util.regex.Pattern;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * The search-by-meaning model ships inside the app (assets
 * {@code public/embedding-model}, staged by scripts/stage-embedding-model.mjs).
 * Gezel's knowledge plugin installs only models it downloads, but it counts a
 * model as installed when its store folder holds the files and an
 * {@code installed.json} record of their digests. So at launch, unless already
 * recorded, the bundled files are copied into that folder off the main thread
 * and recorded, and search by meaning and the knowledge catalogs' questions
 * work offline.
 * A model already recorded with the same files is left alone.
 */
final class BundledEmbeddingModel {
    private static final String SOURCE = "public/embedding-model";
    /** Gezel's knowledge store ({@code KnowledgeFiles.root}). */
    private static final String STORE = "gezel-knowledge/catalogs";
    private static final Pattern ID = Pattern.compile("^[a-z0-9][a-z0-9._-]{0,63}$");

    private BundledEmbeddingModel() {}

    static void install(Context context) {
        Context app = context.getApplicationContext();
        Thread thread = new Thread(() -> {
            try { run(app); } catch (Exception ignored) { /* not recorded: the app offers the download */ }
        }, "docblocks-embedding-model");
        thread.setPriority(Thread.MIN_PRIORITY);
        thread.start();
    }

    private static void run(Context context) throws Exception {
        AssetManager assets = context.getAssets();
        JSONObject manifest;
        try (InputStream input = assets.open(SOURCE + "/manifest.json")) {
            manifest = new JSONObject(new String(readAll(input), StandardCharsets.UTF_8));
        } catch (IOException missing) {
            return; // A build without the bundled model.
        }
        String store = manifest.getString("store");
        if (!ID.matcher(store).matches()) return;
        JSONArray files = manifest.getJSONArray("files");
        if (files.length() == 0) return;
        JSONObject expected = new JSONObject();
        for (int index = 0; index < files.length(); index++) {
            JSONObject file = files.getJSONObject(index);
            String name = file.getString("name");
            if (name.contains("..") || name.startsWith("/")) return;
            expected.put(name, file.getString("sha256"));
        }
        File folder = new File(new File(context.getNoBackupFilesDir(), STORE), store);
        File marker = new File(folder, "installed.json");
        if (recorded(marker, expected, folder)) return;

        if (!folder.isDirectory() && !folder.mkdirs()) return;
        new AtomicFile(marker).delete();
        for (int index = 0; index < files.length(); index++) {
            JSONObject file = files.getJSONObject(index);
            String name = file.getString("name");
            File target = new File(folder, name);
            File partial = new File(folder, name + ".bundled");
            File parent = target.getParentFile();
            if (parent != null && !parent.isDirectory() && !parent.mkdirs()) return;
            try (InputStream input = assets.open(SOURCE + "/" + name);
                 OutputStream output = new FileOutputStream(partial)) {
                byte[] buffer = new byte[1 << 16];
                for (int read; (read = input.read(buffer)) != -1;) output.write(buffer, 0, read);
            }
            if (partial.length() != file.getLong("size")) { partial.delete(); return; }
            target.delete();
            if (!partial.renameTo(target)) { partial.delete(); return; }
        }
        AtomicFile record = new AtomicFile(marker);
        FileOutputStream output = null;
        try {
            output = record.startWrite();
            output.write(new JSONObject().put("files", expected).toString().getBytes(StandardCharsets.UTF_8));
            record.finishWrite(output);
        } catch (Exception error) {
            record.failWrite(output);
            throw error;
        }
    }

    /** Whether the store already records exactly these files, all present. */
    private static boolean recorded(File marker, JSONObject expected, File folder) {
        if (!marker.isFile()) return false;
        try (InputStream input = new AtomicFile(marker).openRead()) {
            JSONObject files = new JSONObject(new String(readAll(input), StandardCharsets.UTF_8)).getJSONObject("files");
            if (files.length() != expected.length()) return false;
            for (Iterator<String> names = expected.keys(); names.hasNext();) {
                String name = names.next();
                if (!expected.getString(name).equals(files.optString(name))) return false;
                if (!new File(folder, name).isFile()) return false;
            }
            return true;
        } catch (Exception unreadable) {
            return false;
        }
    }

    private static byte[] readAll(InputStream input) throws IOException {
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        byte[] buffer = new byte[8192];
        for (int read; (read = input.read(buffer)) != -1;) {
            bytes.write(buffer, 0, read);
            if (bytes.size() > 64 * 1024) throw new IOException("Manifest exceeds its limit");
        }
        return bytes.toByteArray();
    }
}
