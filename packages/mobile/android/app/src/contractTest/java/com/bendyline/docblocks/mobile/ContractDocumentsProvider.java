package com.bendyline.docblocks.mobile;
import android.database.*;
import android.os.*;
import android.provider.DocumentsContract;
import android.provider.DocumentsProvider;
import java.io.*;
import java.nio.file.*;
import java.util.*;

/** Test APK only: disposable documents, never a person's workspaces. */
public final class ContractDocumentsProvider extends DocumentsProvider {
    private Path root;
    private static final String[] DOCUMENT_COLUMNS = { DocumentsContract.Document.COLUMN_DOCUMENT_ID, DocumentsContract.Document.COLUMN_DISPLAY_NAME, DocumentsContract.Document.COLUMN_MIME_TYPE, DocumentsContract.Document.COLUMN_SIZE, DocumentsContract.Document.COLUMN_LAST_MODIFIED, DocumentsContract.Document.COLUMN_FLAGS };
    @Override public boolean onCreate() {
        root = getContext().getCacheDir().toPath().resolve("saf-contract");
        try { Files.createDirectories(root); return true; } catch (IOException e) { throw new IllegalStateException(e); }
    }
    private Path resolve(String id) throws FileNotFoundException {
        if (!id.equals("root") && !id.startsWith("root/")) throw new FileNotFoundException();
        Path file = id.equals("root") ? root : root.resolve(id.substring(5)).normalize();
        if (!file.startsWith(root)) throw new FileNotFoundException(); return file;
    }
    private String id(Path path) { return path.equals(root) ? "root" : "root/" + root.relativize(path).toString(); }
    private void row(MatrixCursor cursor, Path path) throws FileNotFoundException {
        try {
            MatrixCursor.RowBuilder row = cursor.newRow(); boolean directory = Files.isDirectory(path);
            int flags = DocumentsContract.Document.FLAG_SUPPORTS_DELETE | DocumentsContract.Document.FLAG_SUPPORTS_RENAME | DocumentsContract.Document.FLAG_SUPPORTS_MOVE;
            flags |= directory ? DocumentsContract.Document.FLAG_DIR_SUPPORTS_CREATE : DocumentsContract.Document.FLAG_SUPPORTS_WRITE;
            for (String column : cursor.getColumnNames()) {
                Object value = null;
                if (column.equals(DocumentsContract.Document.COLUMN_DOCUMENT_ID)) value = id(path);
                else if (column.equals(DocumentsContract.Document.COLUMN_DISPLAY_NAME)) value = path.getFileName().toString();
                else if (column.equals(DocumentsContract.Document.COLUMN_MIME_TYPE)) value = directory ? DocumentsContract.Document.MIME_TYPE_DIR : "application/octet-stream";
                else if (column.equals(DocumentsContract.Document.COLUMN_SIZE)) value = directory ? 0L : Files.size(path);
                else if (column.equals(DocumentsContract.Document.COLUMN_LAST_MODIFIED)) value = Files.getLastModifiedTime(path).toMillis();
                else if (column.equals(DocumentsContract.Document.COLUMN_FLAGS)) value = flags;
                row.add(column, value);
            }
        } catch (IOException e) { throw new FileNotFoundException(e.getMessage()); }
    }
    @Override public Cursor queryRoots(String[] projection) {
        MatrixCursor cursor = new MatrixCursor(new String[]{DocumentsContract.Root.COLUMN_ROOT_ID, DocumentsContract.Root.COLUMN_DOCUMENT_ID, DocumentsContract.Root.COLUMN_TITLE, DocumentsContract.Root.COLUMN_FLAGS});
        cursor.addRow(new Object[]{"root", "root", "DocBlocks contract tests", DocumentsContract.Root.FLAG_SUPPORTS_CREATE | DocumentsContract.Root.FLAG_SUPPORTS_IS_CHILD}); return cursor;
    }
    @Override public Cursor queryDocument(String documentId, String[] projection) throws FileNotFoundException {
        MatrixCursor cursor = new MatrixCursor(projection == null ? DOCUMENT_COLUMNS : projection); Path path = resolve(documentId); if (Files.exists(path)) row(cursor, path); return cursor;
    }
    @Override public Cursor queryChildDocuments(String parent, String[] projection, String sortOrder) throws FileNotFoundException {
        MatrixCursor cursor = new MatrixCursor(projection == null ? DOCUMENT_COLUMNS : projection);
        try (DirectoryStream<Path> stream = Files.newDirectoryStream(resolve(parent))) { for (Path path : stream) row(cursor, path); } catch (IOException e) { throw new FileNotFoundException(e.getMessage()); } return cursor;
    }
    @Override public ParcelFileDescriptor openDocument(String id, String mode, CancellationSignal signal) throws FileNotFoundException { return ParcelFileDescriptor.open(resolve(id).toFile(), ParcelFileDescriptor.parseMode(mode)); }
    @Override public String createDocument(String parent, String mime, String name) throws FileNotFoundException {
        if (name.contains("/") || name.equals(".") || name.equals("..")) throw new FileNotFoundException();
        Path path = resolve(parent).resolve(name);
        try { if (mime.equals(DocumentsContract.Document.MIME_TYPE_DIR)) Files.createDirectory(path); else Files.createFile(path); return id(path); }
        catch (IOException e) { throw new FileNotFoundException(e.getMessage()); }
    }
    @Override public void deleteDocument(String id) throws FileNotFoundException { try { Files.delete(resolve(id)); } catch (IOException e) { throw new FileNotFoundException(e.getMessage()); } }
    @Override public String renameDocument(String id, String name) throws FileNotFoundException {
        if (name.contains("/") || name.equals(".") || name.equals("..")) throw new FileNotFoundException();
        Path source = resolve(id), target = source.resolveSibling(name);
        try { Files.move(source, target); return id(target); } catch (IOException e) { throw new FileNotFoundException(e.getMessage()); }
    }
    @Override public String moveDocument(String id, String sourceParent, String targetParent) throws FileNotFoundException {
        Path source = resolve(id), target = resolve(targetParent).resolve(source.getFileName());
        try { Files.move(source, target); return id(target); } catch (IOException e) { throw new FileNotFoundException(e.getMessage()); }
    }
    @Override public boolean isChildDocument(String parent, String child) { try { return resolve(child).startsWith(resolve(parent)); } catch (Exception e) { return false; } }
}
