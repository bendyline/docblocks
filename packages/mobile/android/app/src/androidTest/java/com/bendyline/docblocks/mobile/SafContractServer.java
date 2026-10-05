package com.bendyline.docblocks.mobile;

import android.content.ContentResolver;
import android.net.Uri;
import android.os.Bundle;
import android.provider.DocumentsContract;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.json.JSONObject;
import java.io.*;
import java.net.*;
import java.nio.file.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
import static org.junit.Assert.*;

/** A loopback, token-authenticated harness present only in the isolated test APK. */
@RunWith(AndroidJUnit4.class)
public final class SafContractServer {
    @Test public void runContract() throws Exception {
        Bundle args = InstrumentationRegistry.getArguments();
        String token = args.getString("docblocksToken");
        assertNotNull("Supply a fresh test token", token); assertTrue(token.matches("[a-f0-9]{64}"));
        ContentResolver resolver = InstrumentationRegistry.getInstrumentation().getTargetContext().getContentResolver();
        Uri root = DocumentsContract.buildDocumentUri("com.bendyline.docblocks.contract.documents", "root");
        boolean stopped = false;
        try (ServerSocket server = new ServerSocket(19874, 4, InetAddress.getByName("127.0.0.1"))) {
            server.setSoTimeout(120_000);
            while (!stopped) {
                try (Socket socket = server.accept()) {
                    socket.setSoTimeout(30_000);
                    BufferedReader input = new BufferedReader(new InputStreamReader(socket.getInputStream(), StandardCharsets.UTF_8));
                    BufferedWriter output = new BufferedWriter(new OutputStreamWriter(socket.getOutputStream(), StandardCharsets.UTF_8));
                    // Authentication happens before any storage is created or accessed.
                    String greeting = input.readLine();
                    if (!token.equals(greeting)) continue;
                    String first = input.readLine();
                    if ("ping".equals(first)) { output.write("pong\n"); output.flush(); continue; }
                    if ("shutdown".equals(first)) { stopped = true; continue; }
                    boolean saf = !"local".equals(args.getString("docblocksBackend"));
                    Uri directory = saf ? DocumentsContract.createDocument(resolver, root, DocumentsContract.Document.MIME_TYPE_DIR, UUID.randomUUID().toString()) : null;
                    Path local = saf ? null : Files.createTempDirectory(InstrumentationRegistry.getInstrumentation().getTargetContext().getCacheDir().toPath(), "local-contract-");
                    Storage storage = new Storage(saf ? Collections.emptyMap() : Collections.singletonMap("local", local));
                    if (saf) {
                        assertNotNull(directory);
                        Uri tree = DocumentsContract.buildTreeDocumentUri(directory.getAuthority(), DocumentsContract.getDocumentId(directory));
                        storage.register("local", new SafStorageNode(resolver, tree));
                    }
                    try {
                        String line = first;
                        while (line != null) {
                            if (line.length() > 400_000) throw new IOException("Oversized test request");
                            output.write(storage.request(new JSONObject(line)).toString()); output.newLine(); output.flush();
                            line = input.readLine();
                        }
                    } finally { storage.shutdown();
                        if (saf) erase(resolver, directory);
                        else try (java.util.stream.Stream<Path> files = Files.walk(local)) { for (Path file : (Iterable<Path>)files.sorted(Comparator.reverseOrder())::iterator) Files.delete(file); } }
                }
            }
        }
        assertTrue(stopped);
    }
    @Test public void replacedAndRevokedRootsFailClosed() throws Exception {
        Path parent = Files.createTempDirectory(InstrumentationRegistry.getInstrumentation().getTargetContext().getCacheDir().toPath(), "authority-test-");
        Path root = Files.createDirectory(parent.resolve("workspace"));
        Storage storage = new Storage(Collections.singletonMap("local", root));
        try {
            assertTrue(storage.request(Storage.object("op", "open", "instanceId", "test", "providerId", "local", "label", "Test")).getBoolean("ok"));
            Files.move(root, parent.resolve("old")); Files.createDirectory(root);
            assertEquals("permission-denied", storage.request(Storage.object("op", "stat", "instanceId", "test", "path", "")).getJSONObject("error").getString("code"));
            storage.unregister("local");
            assertEquals("disposed", storage.request(Storage.object("op", "stat", "instanceId", "test", "path", "")).getJSONObject("error").getString("code"));
        } finally {
            storage.shutdown(); Files.delete(root); Files.delete(parent.resolve("old")); Files.delete(parent);
        }
    }
    private void erase(ContentResolver resolver, Uri document) throws Exception {
        String id = DocumentsContract.getDocumentId(document);
        try (android.database.Cursor cursor = resolver.query(DocumentsContract.buildChildDocumentsUri(document.getAuthority(), id), new String[]{DocumentsContract.Document.COLUMN_DOCUMENT_ID, DocumentsContract.Document.COLUMN_MIME_TYPE}, null, null, null)) {
            if (cursor != null) while (cursor.moveToNext()) {
                Uri child = DocumentsContract.buildDocumentUri(document.getAuthority(), cursor.getString(0));
                if (DocumentsContract.Document.MIME_TYPE_DIR.equals(cursor.getString(1))) erase(resolver, child);
                else assertTrue(DocumentsContract.deleteDocument(resolver, child));
            }
        }
        assertTrue(DocumentsContract.deleteDocument(resolver, document));
    }
}
