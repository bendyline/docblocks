package com.bendyline.docblocks.mobile;

import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.DocumentsContract;
import java.io.File;

/**
 * Documents/DocBlocks, where the folder picker opens. It is created first, so
 * the user grants it with "Use this folder" instead of making a folder in the
 * picker. Android only grants lasting access to a shared folder through the
 * picker; creating the directory needs no permission from Android 11, where
 * shared storage takes file paths again. Earlier versions open at Documents.
 */
final class SuggestedFolder {
    private SuggestedFolder() {}

    private static final String NAME = "DocBlocks";
    private static final String STORAGE = "com.android.externalstorage.documents";

    /** Creates Documents/DocBlocks when it is missing; true when this call made it. */
    static boolean prepare() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return false;
        try {
            File folder = folder();
            return !folder.exists() && folder.mkdirs();
        } catch (SecurityException e) {
            return false;
        }
    }

    /** Where the picker opens: inside Documents/DocBlocks when it exists, else Documents. */
    static Uri initialUri() {
        boolean ready;
        try { ready = folder().isDirectory(); } catch (SecurityException e) { ready = false; }
        String documents = "primary:" + Environment.DIRECTORY_DOCUMENTS;
        return DocumentsContract.buildDocumentUri(STORAGE, ready ? documents + "/" + NAME : documents);
    }

    /** Takes back a folder prepare() made when the user picked nothing and it is still empty. */
    static void discardIfEmpty(boolean created) {
        if (!created) return;
        try {
            File folder = folder();
            String[] entries = folder.list();
            if (entries != null && entries.length == 0) folder.delete();
        } catch (SecurityException ignored) {
            // An empty Documents/DocBlocks left behind is harmless.
        }
    }

    @SuppressWarnings("deprecation")
    private static File folder() {
        return new File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOCUMENTS), NAME);
    }
}
