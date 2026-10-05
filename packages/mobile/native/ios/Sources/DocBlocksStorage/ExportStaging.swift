import Foundation

/// Export bytes are staged before opening a native picker. Tokens are private to one WebView.
public final class ExportStaging {
    private struct Entry { let url: URL; let size: Int; let created: Date; var written: Int }
    private var entries: [String: Entry] = [:]
    private let root: URL
    public init(root: URL) throws {
        self.root = root
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        for url in try FileManager.default.contentsOfDirectory(at: root, includingPropertiesForKeys: [.creationDateKey]) {
            let created = try url.resourceValues(forKeys: [.creationDateKey]).creationDate ?? .distantPast
            if Date().timeIntervalSince(created) > 86400 { try FileManager.default.removeItem(at: url) }
        }
    }
    public func begin(filename: String, size: Int) throws -> String {
        guard size >= 0, size <= Storage.fileBytes, filename.utf16.count <= 255, !filename.isEmpty, filename != ".", filename != "..", !filename.contains("/"), !filename.contains("\\"), !filename.contains(":"), filename.unicodeScalars.allSatisfy({ $0.value >= 32 && $0.value != 127 }) else { throw StorageFailure("corrupt") }
        for (id, entry) in entries where Date().timeIntervalSince(entry.created) > 900 { try cancel(id) }
        guard entries.count < 2 else { throw StorageFailure("busy") }
        let id = UUID().uuidString, folder = root.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: false)
        let url = folder.appendingPathComponent(filename)
        do { try Data().write(to: url, options: .withoutOverwriting) }
        catch { try? FileManager.default.removeItem(at: folder); throw error }
        entries[id] = Entry(url: url, size: size, created: Date(), written: 0); return id
    }
    public func append(_ id: String, offset: Int, base64: String) throws {
        guard var entry = entries[id], offset == entry.written, base64.count <= ((Storage.chunkBytes + 2) / 3) * 4, let bytes = Data(base64Encoded: base64), bytes.base64EncodedString() == base64, bytes.count <= Storage.chunkBytes, offset + bytes.count <= entry.size else { throw StorageFailure("corrupt") }
        let handle = try FileHandle(forWritingTo: entry.url); defer { try? handle.close() }
        try handle.seekToEnd(); try handle.write(contentsOf: bytes)
        entry.written += bytes.count; entries[id] = entry
    }
    public func finish(_ id: String) throws -> URL {
        guard let entry = entries[id], entry.written == entry.size else { throw StorageFailure("corrupt") }
        let handle = try FileHandle(forWritingTo: entry.url); defer { try? handle.close() }; try handle.synchronize()
        return entry.url
    }
    public func cancel(_ id: String) throws {
        guard let entry = entries.removeValue(forKey: id) else { return }
        try FileManager.default.removeItem(at: entry.url.deletingLastPathComponent())
    }
}
