package com.bendyline.docblocks.mobile;

import java.io.*;
import java.nio.channels.FileChannel;
import java.nio.file.*;
import java.nio.file.attribute.BasicFileAttributes;
import java.util.*;

/** Minimal native I/O substrate. Storage owns paths, versions, conditional operations and transfer ownership. */
interface StorageNode {
    String name();
    StorageNode parent();
    StorageNode child(String name);
    boolean containedBy(StorageNode root);
    BasicFileAttributes attributes() throws Exception;
    List<String> names() throws Exception;
    InputStream openRead() throws Exception;
    void mkdir() throws Exception;
    void writeNew(byte[] bytes) throws Exception;
    void sync() throws Exception;
    void publishNoReplace(StorageNode target) throws Exception;
    void replace(StorageNode target) throws Exception;
    void moveTo(StorageNode target) throws Exception;
    void delete() throws Exception;
}

final class LocalStorageNode implements StorageNode {
    final Path path;
    LocalStorageNode(Path path) { this.path = path; }
    public String name() { return path.getFileName().toString(); }
    public StorageNode parent() { return new LocalStorageNode(path.getParent()); }
    public StorageNode child(String name) { return new LocalStorageNode(path.resolve(name)); }
    public boolean containedBy(StorageNode root) { return root instanceof LocalStorageNode && path.normalize().startsWith(((LocalStorageNode)root).path); }
    public BasicFileAttributes attributes() throws IOException {
        try { return Files.readAttributes(path, BasicFileAttributes.class, LinkOption.NOFOLLOW_LINKS); } catch (NoSuchFileException e) { return null; }
    }
    public List<String> names() throws Exception {
        List<String> names = new ArrayList<>();
        try (DirectoryStream<Path> stream = Files.newDirectoryStream(path)) {
            for (Path child : stream) { if (names.size() >= 10_000) throw new Storage.Failure("quota-exceeded"); names.add(child.getFileName().toString()); }
        }
        Collections.sort(names); return names;
    }
    public InputStream openRead() throws IOException { return Files.newInputStream(path); }
    public void mkdir() throws IOException { Files.createDirectory(path); }
    public void writeNew(byte[] bytes) throws IOException { Files.write(path, bytes, StandardOpenOption.CREATE_NEW, StandardOpenOption.WRITE); }
    public void sync() throws IOException { try (FileChannel channel = FileChannel.open(path, StandardOpenOption.WRITE)) { channel.force(true); } }
    public void publishNoReplace(StorageNode target) throws IOException { Files.move(path, ((LocalStorageNode)target).path); }
    public void replace(StorageNode target) throws IOException { Files.move(path, ((LocalStorageNode)target).path, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING); }
    public void moveTo(StorageNode target) throws IOException { Files.move(path, ((LocalStorageNode)target).path); }
    public void delete() throws IOException { Files.delete(path); }
    @Override public boolean equals(Object other) { return other instanceof LocalStorageNode && path.equals(((LocalStorageNode)other).path); }
    @Override public int hashCode() { return path.hashCode(); }
}
