package com.bendyline.docblocks.mobile;

import org.json.JSONArray;
import org.json.JSONObject;
import java.io.*;
import java.nio.channels.FileChannel;
import java.nio.file.*;
import java.nio.file.attribute.BasicFileAttributes;
import java.security.MessageDigest;
import java.time.Instant;
import java.util.*;

/** Native authority and mutation serialization. Also runs unchanged in the JVM conformance harness. */
public final class Storage {
    public static final int FILE_BYTES = 16 * 1024 * 1024, CHUNK_BYTES = 256 * 1024, TOTAL_BYTES = 32 * 1024 * 1024;
    private final Map<String, StorageNode> roots = new HashMap<>();
    private final Map<String, Object> identities = new HashMap<>();
    private final Map<String, String> instances = new HashMap<>();
    private final Map<String, Transfer> transfers = new HashMap<>();
    private boolean dead;
    static final class Failure extends Exception { final String code; Failure(String code) { super(code); this.code = code; } }
    private static final class Transfer {
        String owner, path; int size; JSONObject options; boolean writing; long created, touched; ByteArrayOutputStream data;
    }
    private static final class Budget { int entries, bytes; }
    public Storage(Map<String, Path> roots) throws IOException {
        for (Map.Entry<String, Path> entry : roots.entrySet()) {
            LocalStorageNode root = new LocalStorageNode(entry.getValue().toRealPath());
            this.roots.put(entry.getKey(), root); identities.put(entry.getKey(), root.attributes().fileKey());
        }
    }
    synchronized void register(String id, StorageNode root) throws Exception {
        if (dead || roots.size() >= 64 || root.attributes() == null || !root.attributes().isDirectory()) throw new Failure("permission-denied");
        roots.put(id, root); identities.put(id, root.attributes().fileKey());
    }
    synchronized void unregister(String id) {
        roots.remove(id); identities.remove(id);
        java.util.Set<String> revoked = new java.util.HashSet<>();
        instances.forEach((owner, provider) -> { if (provider.equals(id)) revoked.add(owner); });
        revoked.forEach(instances::remove); transfers.entrySet().removeIf(entry -> revoked.contains(entry.getValue().owner));
    }
    public static JSONObject object(Object... pairs) throws Exception {
        JSONObject result = new JSONObject(); for (int i = 0; i < pairs.length; i += 2) result.put((String)pairs[i], pairs[i + 1] == null ? JSONObject.NULL : pairs[i + 1]); return result;
    }
    public static JSONObject capabilities() throws Exception {
        return object("writeAtomicity", "process", "moveAtomicity", "process", "snapshotAtomicity", "process", "conditionalWrite", "process", "recursiveRemove", true, "watch", false, "caseSensitivity", "platform", "symlinkPolicy", "reject", "durability", "best-effort");
    }
    public synchronized String importDocument(String name, InputStream stream) throws Exception {
        if (dead || !name.toLowerCase(Locale.ROOT).matches(".*\\.(md|markdown)") || name.contains("/") || name.length() > 255) throw new Failure("not-supported");
        canonical(name); ByteArrayOutputStream data = new ByteArrayOutputStream(); byte[] chunk = new byte[CHUNK_BYTES]; int count;
        while ((count = stream.read(chunk)) != -1) { if (data.size() + count > FILE_BYTES) throw new Failure("quota-exceeded"); data.write(chunk, 0, count); }
        Transfer transfer = new Transfer(); transfer.path = "Inbox/" + UUID.randomUUID() + "/" + name; transfer.data = data; transfer.options = object("mode", "create", "createParents", true);
        write(roots.get("local"), transfer); return transfer.path;
    }
    public synchronized void shutdown() { dead = true; instances.clear(); transfers.clear(); }
    public synchronized JSONObject request(JSONObject request) {
        try { if (dead) throw new Failure("disposed"); return object("ok", true, "value", dispatch(request)); }
        catch (Exception e) {
            String code = e instanceof Failure ? ((Failure)e).code : e instanceof NoSuchFileException ? "not-found" : e instanceof FileAlreadyExistsException ? "already-exists" : e instanceof AccessDeniedException || e instanceof SecurityException ? "permission-denied" : e instanceof DirectoryNotEmptyException ? "not-empty" : "io";
            try { return object("ok", false, "error", object("name", "FsError", "code", code, "message", "Native storage: " + code + ".", "operation", null, "path", null, "destinationPath", null, "retryable", Arrays.asList("io", "busy", "aborted").contains(code))); }
            catch (Exception impossible) { throw new IllegalStateException(impossible); }
        }
    }
    private static void exact(JSONObject r, String... keys) throws Exception {
        Set<String> expected = new HashSet<>(Arrays.asList(keys));
        if (r.length() != expected.size()) throw new Failure("corrupt");
        Iterator<String> iter = r.keys(); while (iter.hasNext()) if (!expected.contains(iter.next())) throw new Failure("corrupt");
    }
    private static String string(JSONObject r, String key, int max) throws Exception {
        Object raw = r.opt(key); if (!(raw instanceof String)) throw new Failure("corrupt");
        String s = (String)raw; if (s.length() > max || s.indexOf(0) >= 0) throw new Failure("corrupt"); return s;
    }
    private static String id(JSONObject r, String key) throws Exception {
        String s = string(r, key, 256); if (!s.matches("[a-zA-Z0-9_-]+")) throw new Failure("corrupt"); return s;
    }
    private static int number(JSONObject r, String key, int max) throws Exception {
        Object raw = r.opt(key); if (!(raw instanceof Number)) throw new Failure("corrupt");
        double d = ((Number)raw).doubleValue(); if (!Double.isFinite(d) || d < 0 || d > max || d != Math.rint(d)) throw new Failure("corrupt"); return (int)d;
    }
    private static JSONObject options(JSONObject r, String op) throws Exception {
        Object raw = r.opt("options"); if (!(raw instanceof JSONObject)) throw new Failure("corrupt"); JSONObject opts = (JSONObject)raw;
        List<String> keys = op.equals("writeBegin") ? Arrays.asList("mode", "createParents", "expectedVersion") : op.equals("mkdir") ? Arrays.asList("mode", "createParents") : op.equals("remove") ? Arrays.asList("recursive", "missing", "expectedVersion") : Arrays.asList("createParents", "expectedVersion");
        Iterator<String> iter = opts.keys(); while (iter.hasNext()) if (!keys.contains(iter.next())) throw new Failure("corrupt");
        for (String key : Arrays.asList("createParents", "recursive")) if (opts.has(key) && !(opts.get(key) instanceof Boolean)) throw new Failure("corrupt");
        if (opts.has("mode") && !(op.equals("mkdir") ? Arrays.asList("ensure", "create") : Arrays.asList("upsert", "create", "replace")).contains(string(opts, "mode", 10))) throw new Failure("corrupt");
        if (opts.has("missing") && !Arrays.asList("ignore", "error").contains(string(opts, "missing", 10))) throw new Failure("corrupt");
        if (opts.has("expectedVersion") && !(opts.isNull("expectedVersion") && op.equals("writeBegin"))) { if (string(opts, "expectedVersion", 1024).isEmpty()) throw new Failure("corrupt"); }
        return opts;
    }
    private static void canonical(String path) throws Exception {
        if (path.length() > 4096 || path.startsWith("/") || path.endsWith("/") || path.indexOf('\\') >= 0 || path.matches("^[a-zA-Z]:.*")) throw new Failure("invalid-path");
        for (char c : path.toCharArray()) if (c < 32 || c == 127) throw new Failure("invalid-path");
        if (!path.isEmpty()) {
            String[] parts = path.split("/", -1); if (parts.length > 128) throw new Failure("invalid-path");
            for (String part : parts) if (part.isEmpty() || part.equals(".") || part.equals("..")) throw new Failure("invalid-path");
        }
    }
    private static BasicFileAttributes attributes(StorageNode node) throws Exception { return node.attributes(); }
    private static StorageNode resolve(StorageNode root, String path) throws Exception {
        canonical(path); StorageNode current = root;
        List<String> parts = new ArrayList<>(); parts.add(""); if (!path.isEmpty()) parts.addAll(Arrays.asList(path.split("/")));
        for (int index = 0; index < parts.size(); index++) {
            if (!parts.get(index).isEmpty()) current = current.child(parts.get(index));
            BasicFileAttributes attrs = attributes(current);
            if (attrs != null) { if (attrs.isSymbolicLink()) throw new Failure("path-escape"); if (index + 1 < parts.size() && !attrs.isDirectory()) throw new Failure("type-mismatch"); }
        }
        if (!current.containedBy(root)) throw new Failure("path-escape"); return current;
    }
    private static String hash(byte[] bytes) throws Exception {
        byte[] digest = MessageDigest.getInstance("SHA-256").digest(bytes); StringBuilder out = new StringBuilder(); for (byte b : digest) out.append(String.format(Locale.ROOT, "%02x", b & 255)); return out.toString();
    }
    private static List<String> names(StorageNode node) throws Exception { return node.names(); }
    private static byte[] readBounded(StorageNode path) throws Exception {
        try (InputStream stream = path.openRead(); ByteArrayOutputStream data = new ByteArrayOutputStream()) {
            byte[] chunk = new byte[CHUNK_BYTES]; int count;
            while ((count = stream.read(chunk)) != -1) { if (data.size() + count > FILE_BYTES) throw new Failure("quota-exceeded"); data.write(chunk, 0, count); }
            return data.toByteArray();
        }
    }
    private static List<JSONObject> scan(StorageNode root, String path, Budget budget, boolean includeBytes) throws Exception {
        if (++budget.entries > 10_000) throw new Failure("quota-exceeded"); StorageNode url = resolve(root, path); BasicFileAttributes attrs = attributes(url);
        if (attrs == null) return new ArrayList<>(); if (!attrs.isRegularFile() && !attrs.isDirectory()) throw new Failure("not-supported");
        JSONObject entry = object("path", path, "name", path.isEmpty() ? "" : url.name(), "lastModified", attrs.lastModifiedTime().toInstant().toString(), "kind", attrs.isRegularFile() ? "file" : "directory");
        List<JSONObject> result = new ArrayList<>(); result.add(entry);
        if (attrs.isRegularFile()) {
            if (attrs.size() > FILE_BYTES) throw new Failure("quota-exceeded"); byte[] bytes = readBounded(url); budget.bytes += bytes.length;
            if (budget.bytes > TOTAL_BYTES) throw new Failure("quota-exceeded"); entry.put("size", bytes.length); entry.put("version", hash(bytes)); if (includeBytes) entry.put("data", Base64.getEncoder().encodeToString(bytes)); return result;
        }
        JSONArray fingerprints = new JSONArray();
        for (String name : names(url)) {
            List<JSONObject> tree = scan(root, path.isEmpty() ? name : path + "/" + name, budget, includeBytes);
            if (tree.isEmpty()) throw new Failure("conflict"); JSONObject child = tree.get(0);
            fingerprints.put(new JSONArray(Arrays.asList(name, child.getString("kind"), child.getString("version")))); result.addAll(tree);
        }
        entry.put("size", JSONObject.NULL); entry.put("version", hash(fingerprints.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8))); return result;
    }
    private static JSONObject stat(StorageNode root, String path) throws Exception { List<JSONObject> tree = scan(root, path, new Budget(), false); return tree.isEmpty() ? null : tree.get(0); }
    private static void expected(JSONObject opts, JSONObject current) throws Exception {
        if (!opts.has("expectedVersion")) return;
        if (opts.isNull("expectedVersion")) { if (current != null) throw new Failure("conflict"); }
        else if (current == null || !opts.getString("expectedVersion").equals(current.getString("version"))) throw new Failure("conflict");
    }
    private static List<StorageNode> parents(StorageNode root, String path, boolean create) throws Exception {
        StorageNode cursor = resolve(root, path).parent(); List<StorageNode> missing = new ArrayList<>(), created = new ArrayList<>();
        while (!cursor.equals(root) && attributes(cursor) == null) { missing.add(cursor); cursor = cursor.parent(); }
        if (!create && !missing.isEmpty()) throw new Failure("not-found"); BasicFileAttributes attrs = attributes(cursor);
        if (attrs == null || !attrs.isDirectory()) throw new Failure("type-mismatch"); Collections.reverse(missing);
        try { for (StorageNode folder : missing) { folder.mkdir(); created.add(folder); } return created; } catch (Exception e) { rollback(created); throw e; }
    }
    private static void rollback(List<StorageNode> created) { Collections.reverse(created); for (StorageNode path : created) { try { path.delete(); } catch (Exception ignored) { /* Only remove empty operation-owned parents. */ } } }
    private static JSONObject write(StorageNode root, Transfer transfer) throws Exception {
        String path = transfer.path; JSONObject opts = transfer.options; if (path.isEmpty()) throw new Failure("invalid-path");
        StorageNode target = resolve(root, path); JSONObject current = stat(root, path); expected(opts, current); String mode = opts.optString("mode", "upsert");
        if (mode.equals("create") && current != null) throw new Failure("already-exists"); if (mode.equals("replace") && current == null) throw new Failure("not-found");
        if (current != null && !current.getString("kind").equals("file")) throw new Failure("type-mismatch");
        List<StorageNode> created = parents(root, path, opts.optBoolean("createParents", false)); StorageNode temporary = target.parent().child(".docblocks-" + UUID.randomUUID());
        try {
            temporary.writeNew(transfer.data.toByteArray());
            temporary.sync();
            if (current == null || mode.equals("create")) temporary.publishNoReplace(target);
            else temporary.replace(target);
            return stat(root, path);
        } catch (Exception e) { deleteIfPresent(temporary); rollback(created); throw e; } finally { deleteIfPresent(temporary); }
    }
    private Object dispatch(JSONObject r) throws Exception {
        String op = string(r, "op", 32), owner = id(r, "instanceId"); long now = System.currentTimeMillis();
        transfers.entrySet().removeIf(entry -> now - entry.getValue().created > 900_000 || now - entry.getValue().touched > 120_000);
        if (op.equals("open")) {
            exact(r, "op", "instanceId", "providerId", "label"); String provider = id(r, "providerId"); string(r, "label", 1024);
            if (!roots.containsKey(provider) || instances.containsKey(owner) && !instances.get(owner).equals(provider)) throw new Failure("permission-denied");
            if (instances.size() >= 128 && !instances.containsKey(owner)) throw new Failure("busy"); instances.put(owner, provider); return capabilities();
        }
        if (op.equals("dispose")) { exact(r, "op", "instanceId"); instances.remove(owner); transfers.entrySet().removeIf(entry -> entry.getValue().owner.equals(owner)); return JSONObject.NULL; }
        String workspace = instances.get(owner);
        StorageNode root = roots.get(workspace); if (root == null) throw new Failure("disposed");
        BasicFileAttributes identity = root.attributes();
        if (identity == null || !identity.isDirectory() || identity.isSymbolicLink() || !Objects.equals(identity.fileKey(), identities.get(workspace))) throw new Failure("permission-denied");
        switch (op) {
        case "stat": case "list": case "readBegin": {
            exact(r, "op", "instanceId", "path"); String path = string(r, "path", 4096); StorageNode url = resolve(root, path); JSONObject current = stat(root, path);
            if (op.equals("stat")) return current == null ? JSONObject.NULL : current;
            if (op.equals("list")) {
                if (current == null) throw new Failure("not-found"); if (!current.getString("kind").equals("directory")) throw new Failure("type-mismatch");
                List<JSONObject> entries = new ArrayList<>(); for (String name : names(url)) { JSONObject item = stat(root, path.isEmpty() ? name : path + "/" + name); if (item == null) throw new Failure("conflict"); entries.add(item); }
                entries.sort((a, b) -> { int kind = a.optString("kind").compareTo(b.optString("kind")); return kind == 0 ? a.optString("name").compareTo(b.optString("name")) : kind; }); return new JSONArray(entries);
            }
            if (current == null) return JSONObject.NULL; if (!current.getString("kind").equals("file")) throw new Failure("type-mismatch");
            byte[] bytes = readBounded(url); current.put("size", bytes.length); current.put("version", hash(bytes)); String token = addTransfer(owner, path, bytes.length, new JSONObject(), false, bytes);
            return object("transferId", token, "entry", current);
        }
        case "writeBegin": {
            exact(r, "op", "instanceId", "path", "byteLength", "options"); String path = string(r, "path", 4096); resolve(root, path); if (path.isEmpty()) throw new Failure("invalid-path");
            return addTransfer(owner, path, number(r, "byteLength", FILE_BYTES), options(r, op), true, new byte[0]);
        }
        case "readChunk": case "writeChunk": case "writeFinish": case "closeTransfer": {
            if (op.equals("readChunk")) exact(r, "op", "instanceId", "transferId", "offset"); else if (op.equals("writeChunk")) exact(r, "op", "instanceId", "transferId", "offset", "data"); else exact(r, "op", "instanceId", "transferId");
            String token = id(r, "transferId"); Transfer transfer = transfers.get(token);
            if (op.equals("closeTransfer") && transfer == null) return JSONObject.NULL;
            if (transfer == null || !transfer.owner.equals(owner)) throw new Failure("permission-denied");
            if (op.equals("closeTransfer")) { transfers.remove(token); return JSONObject.NULL; }
            transfer.touched = now;
            if (op.equals("readChunk")) { if (transfer.writing) throw new Failure("corrupt"); int offset = number(r, "offset", transfer.size); return Base64.getEncoder().encodeToString(Arrays.copyOfRange(transfer.data.toByteArray(), offset, Math.min(offset + CHUNK_BYTES, transfer.size))); }
            if (!transfer.writing) throw new Failure("corrupt");
            if (op.equals("writeChunk")) {
                int offset = number(r, "offset", FILE_BYTES); String encoded = string(r, "data", ((CHUNK_BYTES + 2) / 3) * 4); byte[] bytes;
                try { bytes = Base64.getDecoder().decode(encoded); } catch (IllegalArgumentException e) { throw new Failure("corrupt"); }
                if (!Base64.getEncoder().encodeToString(bytes).equals(encoded) || bytes.length > CHUNK_BYTES || offset != transfer.data.size() || offset + bytes.length > transfer.size) throw new Failure("corrupt");
                transfer.data.write(bytes); return JSONObject.NULL;
            }
            transfers.remove(token); if (transfer.data.size() != transfer.size) throw new Failure("corrupt"); return write(root, transfer);
        }
        case "mkdir": {
            exact(r, "op", "instanceId", "path", "options"); String path = string(r, "path", 4096); JSONObject opts = options(r, op); StorageNode url = resolve(root, path); JSONObject current = stat(root, path);
            if (current != null) { if (opts.optString("mode").equals("create")) throw new Failure(path.isEmpty() ? "invalid-path" : "already-exists"); if (!current.getString("kind").equals("directory")) throw new Failure("type-mismatch"); return current; }
            List<StorageNode> created = parents(root, path, opts.optBoolean("createParents", false)); try { url.mkdir(); return stat(root, path); } catch (Exception e) { rollback(created); throw e; }
        }
        case "remove": {
            exact(r, "op", "instanceId", "path", "options"); String path = string(r, "path", 4096); JSONObject opts = options(r, op); StorageNode url = resolve(root, path); if (path.isEmpty()) throw new Failure("invalid-path"); JSONObject current = stat(root, path); expected(opts, current);
            if (current == null) { if (!opts.optString("missing", "error").equals("ignore")) throw new Failure("not-found"); }
            else if (current.getString("kind").equals("directory") && opts.optBoolean("recursive", false)) {
                List<JSONObject> tree = scan(root, path, new Budget(), false); Collections.reverse(tree); for (JSONObject item : tree) resolve(root, item.getString("path")).delete();
            } else url.delete();
            return object("removed", current != null, "version", stat(root, "").getString("version"));
        }
        case "move": {
            exact(r, "op", "instanceId", "oldPath", "newPath", "options"); String old = string(r, "oldPath", 4096), next = string(r, "newPath", 4096); JSONObject opts = options(r, op);
            if (old.isEmpty() || next.isEmpty() || next.startsWith(old + "/")) throw new Failure("invalid-path"); StorageNode source = resolve(root, old), destination = resolve(root, next); JSONObject current = stat(root, old);
            if (current == null) throw new Failure("not-found"); expected(opts, current); if (old.equals(next)) return current; if (attributes(destination) != null) throw new Failure("already-exists");
            List<StorageNode> created = parents(root, next, opts.optBoolean("createParents", false)); try { source.moveTo(destination); return stat(root, next); } catch (Exception e) { rollback(created); throw e; }
        }
        case "snapshot": {
            exact(r, "op", "instanceId"); List<JSONObject> entries = scan(root, "", new Budget(), true); entries.sort(Comparator.comparing(item -> item.optString("path"))); return object("version", entries.get(0).getString("version"), "entries", new JSONArray(entries));
        }
        default: throw new Failure("not-supported");
        }
    }
    private static void deleteIfPresent(StorageNode node) throws Exception { if (node.attributes() != null) node.delete(); }
    private String addTransfer(String owner, String path, int size, JSONObject options, boolean writing, byte[] bytes) throws Exception {
        int total = size; for (Transfer transfer : transfers.values()) total += transfer.size; if (transfers.size() >= 4 || total > TOTAL_BYTES) throw new Failure("busy");
        Transfer transfer = new Transfer(); transfer.owner = owner; transfer.path = path; transfer.size = size; transfer.options = options; transfer.writing = writing; transfer.created = transfer.touched = System.currentTimeMillis(); transfer.data = new ByteArrayOutputStream(); transfer.data.write(bytes);
        String token = UUID.randomUUID().toString(); transfers.put(token, transfer); return token;
    }
}
