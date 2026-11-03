package com.bendyline.docblocks.mobile;

import android.content.*;
import android.net.Uri;
import android.provider.DocumentsContract;
import org.json.*;
import java.nio.file.*;
import java.util.*;

/** Persist URI grants separately from display metadata and document recovery. */
final class WorkspaceRegistry {
    private final Context context;
    private final Path file;
    private final List<JSONObject> entries = new ArrayList<>();
    /** The first-run storage decision lives beside, not inside, the grant records older builds wrote. */
    private final Path choice;
    private boolean chosen;
    private String defaultId;
    WorkspaceRegistry(Context context) throws Exception {
        this.context = context; file = context.getFilesDir().toPath().resolve("workspaces.json"); choice = file.resolveSibling("storage-choice.json");
        try {
            if (Files.size(choice) > 4096) throw new Storage.Failure("corrupt");
            JSONObject record = new JSONObject(new String(Files.readAllBytes(choice), java.nio.charset.StandardCharsets.UTF_8)); Object id = record.opt("defaultId");
            if (record.length() != 1 || !record.has("defaultId") || !(id == JSONObject.NULL || id instanceof String && UUID.fromString((String)id).toString().equals(id))) throw new Storage.Failure("corrupt");
            chosen = true; defaultId = id == JSONObject.NULL ? null : (String)id;
        } catch (NoSuchFileException undecided) { /* First launch, or a build from before the storage choice. */ }
        byte[] data;
        try { if (Files.size(file) > 4 * 1024 * 1024) throw new Storage.Failure("corrupt"); data = Files.readAllBytes(file); }
        catch (NoSuchFileException absent) { return; }
        JSONArray records = new JSONArray(new String(data, java.nio.charset.StandardCharsets.UTF_8)); if (records.length() > 63) throw new Storage.Failure("corrupt");
        Set<String> ids = new HashSet<>();
        for (int i = 0; i < records.length(); i++) {
            JSONObject record = records.getJSONObject(i);
            if (!(record.opt("id") instanceof String) || !(record.opt("name") instanceof String) || !(record.opt("uri") instanceof String) || record.length() != 3 || !record.has("id") || !record.has("name") || !record.has("uri")) throw new Storage.Failure("corrupt");
            String id = record.getString("id"), name = record.getString("name"), uri = record.getString("uri");
            if (!UUID.fromString(id).toString().equals(id) || !ids.add(id) || name.isEmpty() || name.length() > 1024 || uri.length() > 8192 || !"content".equals(Uri.parse(uri).getScheme()) || !DocumentsContract.isTreeUri(Uri.parse(uri))) throw new Storage.Failure("corrupt");
            entries.add(record);
        }
    }
    private boolean permitted(Uri uri) {
        for (android.content.UriPermission permission : context.getContentResolver().getPersistedUriPermissions()) if (permission.getUri().equals(uri) && permission.isReadPermission() && permission.isWritePermission()) return true;
        return false;
    }
    synchronized void restore(Storage storage) throws Exception {
        for (JSONObject entry : entries) {
            Uri uri = Uri.parse(entry.getString("uri"));
            if (permitted(uri)) {
                try { storage.register(entry.getString("id"), new SafStorageNode(context.getContentResolver(), uri)); }
                catch (Exception unavailable) { /* The saved root remains listed and fails on open; it is never replaced. */ }
            }
        }
    }
    /** The chosen default folder first, then device storage, then other folders: the host treats index 0 as the default. */
    synchronized JSONArray list(JSONObject device) throws Exception {
        JSONArray result = new JSONArray(); JSONObject preferred = null;
        for (JSONObject entry : entries) if (entry.getString("id").equals(defaultId)) preferred = entry;
        if (preferred != null) result.put(info(preferred));
        result.put(device);
        for (JSONObject entry : entries) if (entry != preferred) result.put(info(entry));
        return result;
    }
    /** Picked folders predate the first-run choice, so they count as a decision already made. */
    synchronized boolean decided() { return chosen || !entries.isEmpty(); }
    /** Records the first-run decision; null keeps documents in device storage. */
    synchronized void choose(String id) throws Exception {
        replace(choice, Storage.object("defaultId", id).toString()); chosen = true; defaultId = id;
    }
    private JSONObject info(JSONObject entry) throws Exception { return Storage.object("id", entry.getString("id"), "name", entry.getString("name"), "rootPath", "Files / " + entry.getString("name")); }
    synchronized JSONObject add(Uri uri, int flags, Storage storage) throws Exception {
        int modes = Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION;
        if (!"content".equals(uri.getScheme()) || !DocumentsContract.isTreeUri(uri) || uri.toString().length() > 8192 || (flags & modes) != modes || entries.size() >= 63) throw new Storage.Failure("permission-denied");
        boolean existed = permitted(uri);
        context.getContentResolver().takePersistableUriPermission(uri, flags & modes);
        try {
            for (JSONObject entry : entries) if (entry.getString("uri").equals(uri.toString())) { storage.register(entry.getString("id"), new SafStorageNode(context.getContentResolver(), uri)); return info(entry); }
            String name;
            try (android.database.Cursor cursor = context.getContentResolver().query(DocumentsContract.buildDocumentUriUsingTree(uri, DocumentsContract.getTreeDocumentId(uri)), new String[]{DocumentsContract.Document.COLUMN_DISPLAY_NAME}, null, null, null)) {
                if (cursor == null || !cursor.moveToFirst()) throw new Storage.Failure("permission-denied"); name = cursor.getString(0);
            }
            if (name == null || name.isEmpty() || name.length() > 1024) throw new Storage.Failure("corrupt");
            String id = UUID.randomUUID().toString(); JSONObject entry = Storage.object("id", id, "name", name, "uri", uri.toString());
            storage.register(id, new SafStorageNode(context.getContentResolver(), uri));
            List<JSONObject> updated = new ArrayList<>(entries); updated.add(entry);
            try { persist(updated); } catch (Exception failure) { storage.unregister(id); throw failure; }
            entries.add(entry); return info(entry);
        } catch (Exception error) { if (!existed) context.getContentResolver().releasePersistableUriPermission(uri, flags & modes); throw error; }
    }
    synchronized void remove(String id, Storage storage) throws Exception {
        List<JSONObject> remaining = new ArrayList<>(); JSONObject removed = null;
        for (JSONObject entry : entries) { if (entry.getString("id").equals(id)) removed = entry; else remaining.add(entry); }
        persist(remaining); entries.clear(); entries.addAll(remaining); storage.unregister(id);
        if (id.equals(defaultId)) choose(null);
        if (removed != null) {
            Uri uri = Uri.parse(removed.getString("uri")); if (permitted(uri)) context.getContentResolver().releasePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
        }
    }
    private void persist(List<JSONObject> records) throws Exception { replace(file, new JSONArray(records).toString()); }
    private static void replace(Path target, String text) throws Exception {
        Path temporary = target.resolveSibling(".workspaces-" + UUID.randomUUID());
        try {
            Files.write(temporary, text.getBytes(java.nio.charset.StandardCharsets.UTF_8), StandardOpenOption.CREATE_NEW);
            try (java.nio.channels.FileChannel channel = java.nio.channels.FileChannel.open(temporary, StandardOpenOption.WRITE)) { channel.force(true); }
            Files.move(temporary, target, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
        } finally { Files.deleteIfExists(temporary); }
    }
}
