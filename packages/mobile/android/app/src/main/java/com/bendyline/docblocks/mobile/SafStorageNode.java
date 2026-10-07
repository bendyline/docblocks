package com.bendyline.docblocks.mobile;

import android.content.ContentResolver;
import android.database.Cursor;
import android.net.Uri;
import android.provider.DocumentsContract;
import java.io.*;
import java.nio.file.*;
import java.nio.file.attribute.*;
import java.util.*;

/** An exact tree grant. Content URIs never become local paths or renderer authority. */
final class SafStorageNode implements StorageNode {
    private static final String[] COLUMNS = { DocumentsContract.Document.COLUMN_DOCUMENT_ID, DocumentsContract.Document.COLUMN_DISPLAY_NAME, DocumentsContract.Document.COLUMN_MIME_TYPE, DocumentsContract.Document.COLUMN_SIZE, DocumentsContract.Document.COLUMN_LAST_MODIFIED, DocumentsContract.Document.COLUMN_FLAGS };
    private final ContentResolver resolver;
    private final Uri tree;
    private final String relative;
    SafStorageNode(ContentResolver resolver, Uri tree) { this(resolver, tree, ""); }
    private SafStorageNode(ContentResolver resolver, Uri tree, String relative) { this.resolver = resolver; this.tree = tree; this.relative = relative; }
    public String name() { int slash = relative.lastIndexOf('/'); return relative.substring(slash + 1); }
    public StorageNode parent() { int slash = relative.lastIndexOf('/'); return new SafStorageNode(resolver, tree, slash < 0 ? "" : relative.substring(0, slash)); }
    public StorageNode child(String name) { return new SafStorageNode(resolver, tree, relative.isEmpty() ? name : relative + "/" + name); }
    public boolean containedBy(StorageNode root) { return root instanceof SafStorageNode && tree.equals(((SafStorageNode)root).tree) && (relative.equals(((SafStorageNode)root).relative) || relative.startsWith(((SafStorageNode)root).relative.isEmpty() ? "" : ((SafStorageNode)root).relative + "/")); }
    private static final class Document implements BasicFileAttributes {
        final String id, name, mime; final long size, modified; final int flags;
        Document(Cursor cursor) throws Exception {
            id = cursor.getString(0); name = cursor.getString(1); mime = cursor.getString(2); size = cursor.isNull(3) ? 0 : cursor.getLong(3); modified = cursor.isNull(4) ? 0 : cursor.getLong(4); flags = cursor.getInt(5);
            if (id == null || id.length() > 8192 || name == null || name.length() > 255 || mime == null || size < 0 || modified < 0 || name.contains("/") || name.contains("\\") || name.equals(".") || name.equals("..")) throw new Storage.Failure("corrupt");
            if ((flags & DocumentsContract.Document.FLAG_VIRTUAL_DOCUMENT) != 0) throw new Storage.Failure("not-supported");
        }
        public FileTime lastModifiedTime() { return FileTime.fromMillis(modified); }
        public FileTime lastAccessTime() { return lastModifiedTime(); }
        public FileTime creationTime() { return lastModifiedTime(); }
        public boolean isRegularFile() { return !isDirectory(); }
        public boolean isDirectory() { return DocumentsContract.Document.MIME_TYPE_DIR.equals(mime); }
        public boolean isSymbolicLink() { return false; }
        public boolean isOther() { return false; }
        public long size() { return size; }
        public Object fileKey() { return id; }
    }
    private Uri uri(String id) { return DocumentsContract.buildDocumentUriUsingTree(tree, id); }
    private Document query(Uri url) throws Exception {
        try (Cursor cursor = resolver.query(url, COLUMNS, null, null, null)) {
            if (cursor == null) throw new Storage.Failure("io");
            return cursor.moveToFirst() ? new Document(cursor) : null;
        }
    }
    private List<Document> children(Document parent) throws Exception {
        if (!parent.isDirectory()) throw new Storage.Failure("type-mismatch");
        List<Document> children = new ArrayList<>(); Set<String> names = new HashSet<>();
        try (Cursor cursor = resolver.query(DocumentsContract.buildChildDocumentsUriUsingTree(tree, parent.id), COLUMNS, null, null, null)) {
            if (cursor == null) throw new Storage.Failure("io");
            while (cursor.moveToNext()) {
                if (children.size() >= 10_000) throw new Storage.Failure("quota-exceeded"); Document child = new Document(cursor);
                if (!names.add(child.name)) throw new Storage.Failure("corrupt"); children.add(child);
            }
        }
        return children;
    }
    private Document resolve() throws Exception {
        Document current = query(uri(DocumentsContract.getTreeDocumentId(tree)));
        if (current == null || relative.isEmpty()) return current;
        for (String part : relative.split("/")) {
            Document found = null; for (Document child : children(current)) if (child.name.equals(part)) found = child;
            if (found == null) return null; current = found;
        }
        return current;
    }
    private Document require() throws Exception { Document doc = resolve(); if (doc == null) throw new NoSuchFileException(relative); return doc; }
    public BasicFileAttributes attributes() throws Exception { return resolve(); }
    public List<String> names() throws Exception { List<String> names = new ArrayList<>(); for (Document child : children(require())) names.add(child.name); Collections.sort(names); return names; }
    public InputStream openRead() throws Exception { InputStream stream = resolver.openInputStream(uri(require().id)); if (stream == null) throw new Storage.Failure("io"); return stream; }
    private Uri create(String mime) throws Exception {
        if (relative.isEmpty()) throw new Storage.Failure("invalid-path");
        if (resolve() != null) throw new FileAlreadyExistsException(relative);
        Document parent = ((SafStorageNode)parent()).require();
        if ((parent.flags & DocumentsContract.Document.FLAG_DIR_SUPPORTS_CREATE) == 0) throw new Storage.Failure("permission-denied");
        Uri created = DocumentsContract.createDocument(resolver, uri(parent.id), mime, name());
        if (created == null) throw new Storage.Failure("io");
        Document actual = query(created);
        if (actual == null || !name().equals(actual.name)) {
            if (!DocumentsContract.deleteDocument(resolver, created)) throw new Storage.Failure("corrupt");
            throw new FileAlreadyExistsException(relative);
        }
        return created;
    }
    public void mkdir() throws Exception { create(DocumentsContract.Document.MIME_TYPE_DIR); }
    private void write(Uri target, byte[] bytes) throws Exception {
        try (OutputStream stream = resolver.openOutputStream(target, "wt")) {
            if (stream == null) throw new Storage.Failure("io"); stream.write(bytes); stream.flush();
        }
        // Some providers do not honour truncation modes. Never acknowledge stale trailing bytes.
        try (InputStream stream = resolver.openInputStream(target)) {
            if (stream == null) throw new Storage.Failure("io");
            byte[] chunk = new byte[Storage.CHUNK_BYTES]; int offset = 0, count;
            while ((count = stream.read(chunk)) != -1) {
                if (offset + count > bytes.length) throw new Storage.Failure("corrupt");
                for (int index = 0; index < count; index++) if (bytes[offset + index] != chunk[index]) throw new Storage.Failure("corrupt");
                offset += count;
            }
            if (offset != bytes.length) throw new Storage.Failure("corrupt");
        }
    }
    public void writeNew(byte[] bytes) throws Exception {
        Uri target = create("application/octet-stream");
        try { write(target, bytes); }
        catch (Exception failure) { if (!DocumentsContract.deleteDocument(resolver, target)) throw new Storage.Failure("corrupt"); throw failure; }
    }
    public void sync() { /* Provider close is the available durability boundary; never claim durable. */ }
    private byte[] readBytes() throws Exception {
        try (InputStream input = openRead(); ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            byte[] chunk = new byte[Storage.CHUNK_BYTES]; int count;
            while ((count = input.read(chunk)) != -1) { if (output.size() + count > Storage.FILE_BYTES) throw new Storage.Failure("quota-exceeded"); output.write(chunk, 0, count); }
            return output.toByteArray();
        }
    }
    public void publishNoReplace(StorageNode target) throws Exception { ((SafStorageNode)target).writeNew(readBytes()); }
    public void replace(StorageNode destination) throws Exception {
        SafStorageNode target = (SafStorageNode)destination; Document current = target.require();
        if ((current.flags & DocumentsContract.Document.FLAG_SUPPORTS_WRITE) == 0) throw new Storage.Failure("permission-denied");
        byte[] backup = target.readBytes(), replacement = readBytes(); Uri url = target.uri(current.id);
        try { target.write(url, replacement); }
        catch (Exception failure) { try { target.write(url, backup); } catch (Exception rollback) { throw new Storage.Failure("corrupt"); } throw failure; }
    }
    public void moveTo(StorageNode destination) throws Exception {
        SafStorageNode target = (SafStorageNode)destination;
        if (!tree.equals(target.tree)) throw new Storage.Failure("not-supported");
        if (target.resolve() != null) throw new FileAlreadyExistsException(target.relative);
        Document source = require(), sourceParent = ((SafStorageNode)parent()).require(), targetParent = ((SafStorageNode)target.parent()).require();
        if ((source.flags & DocumentsContract.Document.FLAG_SUPPORTS_RENAME) == 0 || (!sourceParent.id.equals(targetParent.id) && (source.flags & DocumentsContract.Document.FLAG_SUPPORTS_MOVE) == 0)) throw new Storage.Failure("not-supported");
        Uri moved = uri(source.id);
        boolean changedParent = !sourceParent.id.equals(targetParent.id);
        if (changedParent) { moved = DocumentsContract.moveDocument(resolver, moved, uri(sourceParent.id), uri(targetParent.id)); if (moved == null) throw new Storage.Failure("io"); }
        try {
            Uri renamed = source.name.equals(target.name()) ? moved : DocumentsContract.renameDocument(resolver, moved, target.name());
            if (renamed == null) throw new Storage.Failure("io"); moved = renamed;
            Document actual = query(moved); if (actual == null || !actual.name.equals(target.name())) throw new Storage.Failure("conflict");
        } catch (Exception failure) {
            try {
                Document actual = query(moved);
                if (actual != null && !source.name.equals(actual.name)) { moved = DocumentsContract.renameDocument(resolver, moved, source.name); if (moved == null) throw new Storage.Failure("corrupt"); }
                if (changedParent && DocumentsContract.moveDocument(resolver, moved, uri(targetParent.id), uri(sourceParent.id)) == null) throw new Storage.Failure("corrupt");
            } catch (Exception rollback) { throw new Storage.Failure("corrupt"); }
            throw failure;
        }
    }
    public void delete() throws Exception {
        Document doc = require();
        if (doc.isDirectory() && !children(doc).isEmpty()) throw new DirectoryNotEmptyException(relative);
        if ((doc.flags & DocumentsContract.Document.FLAG_SUPPORTS_DELETE) == 0) throw new Storage.Failure("permission-denied");
        if (!DocumentsContract.deleteDocument(resolver, uri(doc.id))) throw new Storage.Failure("io");
    }
    @Override public boolean equals(Object other) { return other instanceof SafStorageNode && tree.equals(((SafStorageNode)other).tree) && relative.equals(((SafStorageNode)other).relative); }
    @Override public int hashCode() { return Objects.hash(tree, relative); }
}
