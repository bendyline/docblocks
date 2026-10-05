package com.bendyline.docblocks.mobile;
import java.nio.file.*;
import java.io.*;
import java.util.*;

public final class ExportStaging {
    private static final class Entry { Path path; int size, written; long created; }
    private final Map<String, Entry> entries = new HashMap<>(); private final Path root;
    public ExportStaging(Path root) throws IOException {
        this.root = root; Files.createDirectories(root);
        try (DirectoryStream<Path> directories = Files.newDirectoryStream(root)) {
            for (Path directory : directories) {
                if (System.currentTimeMillis() - Files.getLastModifiedTime(directory).toMillis() > 86_400_000) remove(directory);
            }
        }
    }
    private static void remove(Path folder) throws IOException {
        try (DirectoryStream<Path> files = Files.newDirectoryStream(folder)) { for (Path file : files) Files.delete(file); } Files.delete(folder);
    }
    public String begin(String filename, int size) throws Exception {
        if (size < 0 || size > Storage.FILE_BYTES || filename.isEmpty() || filename.length() > 255 || filename.equals(".") || filename.equals("..") || filename.matches(".*[\\\\/:\\x00-\\x1f\\x7f].*")) throw new IOException("Invalid export");
        for (String id : new ArrayList<>(entries.keySet())) if (System.currentTimeMillis() - entries.get(id).created > 900_000) cancel(id);
        if (entries.size() >= 2) throw new IOException("Another export is in progress");
        Entry entry = new Entry(); entry.size = size; entry.created = System.currentTimeMillis();
        Path folder = Files.createDirectory(root.resolve(UUID.randomUUID().toString())); entry.path = folder.resolve(filename); Files.createFile(entry.path);
        String id = UUID.randomUUID().toString(); entries.put(id, entry); return id;
    }
    public void append(String id, int offset, String encoded) throws Exception {
        Entry entry = entries.get(id); if (entry == null || offset != entry.written || encoded.length() > ((Storage.CHUNK_BYTES + 2) / 3) * 4) throw new IOException("Invalid export transfer");
        byte[] bytes = Base64.getDecoder().decode(encoded);
        if (!Base64.getEncoder().encodeToString(bytes).equals(encoded) || bytes.length > Storage.CHUNK_BYTES || offset + bytes.length > entry.size) throw new IOException("Invalid export chunk");
        Files.write(entry.path, bytes, StandardOpenOption.APPEND); entry.written += bytes.length;
    }
    public Path finish(String id) throws Exception {
        Entry entry = entries.get(id); if (entry == null || entry.size != entry.written) throw new IOException("Incomplete export");
        try (java.nio.channels.FileChannel channel = java.nio.channels.FileChannel.open(entry.path, StandardOpenOption.WRITE)) { channel.force(true); } return entry.path;
    }
    public void retainForShare(String id) { entries.remove(id); }
    public void cancel(String id) throws Exception { Entry entry = entries.remove(id); if (entry != null) remove(entry.path.getParent()); }
}
