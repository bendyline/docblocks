import Foundation

/// What the Mac app asks its iCloud helper. The Mac app reaches iCloud folders as ordinary files,
/// which hides the versions iCloud sets aside and how far syncing has got; this answers both.
/// Requests and replies are JSON objects, one per line when run as a process.
public final class CloudHelperService {
    public static let pathLimit = 256
    public static let scanLimit = 50_000
    private let cloud: CloudState
    private let conflicts: ConflictVersionSource
    private let fm = FileManager.default
    public init(cloud: CloudState = SystemCloudState(), conflicts: ConflictVersionSource = SystemConflictVersions()) {
        self.cloud = cloud; self.conflicts = conflicts
    }

    public func handle(_ input: Any) -> [String: Any] {
        var reply: [String: Any] = [:]
        let request = input as? [String: Any]
        if let id = request?["id"] as? NSNumber { reply["id"] = id }
        do {
            guard let request, let op = request["op"] as? String else { throw StorageFailure("corrupt") }
            switch op {
            case "status": reply["value"] = try status(request)
            case "scan": reply["value"] = try scan(request)
            case "harvest": reply["value"] = try harvest(request)
            default: throw StorageFailure("not-supported")
            }
            reply["ok"] = true
        } catch {
            reply["ok"] = false
            reply["code"] = (error as? StorageFailure)?.code ?? Self.code(error as NSError)
        }
        return reply
    }
    private static func code(_ error: NSError) -> String {
        guard error.domain == NSCocoaErrorDomain else { return "io" }
        switch error.code {
        case NSFileReadNoSuchFileError, NSFileNoSuchFileError: return "not-found"
        case NSFileReadNoPermissionError, NSFileWriteNoPermissionError: return "permission-denied"
        default: return "io"
        }
    }
    private func absolute(_ value: Any?) throws -> URL {
        guard let path = value as? String, path.hasPrefix("/"), path.utf8.count <= 4096, !path.contains("\0") else { throw StorageFailure("corrupt") }
        return URL(fileURLWithPath: path)
    }
    private func root(_ request: [String: Any]) throws -> URL {
        let url = try absolute(request["root"]).standardizedFileURL.resolvingSymlinksInPath()
        var directory: ObjCBool = false
        guard fm.fileExists(atPath: url.path, isDirectory: &directory) else {
            // A folder the sandbox hides looks missing; say which it is.
            throw StorageFailure(fm.isReadableFile(atPath: url.deletingLastPathComponent().path) ? "not-found" : "permission-denied")
        }
        guard directory.boolValue else { throw StorageFailure("type-mismatch") }
        guard fm.isReadableFile(atPath: url.path) else { throw StorageFailure("permission-denied") }
        return url
    }

    private func status(_ request: [String: Any]) throws -> [[String: Any]] {
        guard let paths = request["paths"] as? [Any], paths.count <= Self.pathLimit else { throw StorageFailure("corrupt") }
        return try paths.map { item in
            let url = try absolute(item)
            var entry: [String: Any] = ["path": url.path]
            guard let upload = cloud.upload(of: url) else { entry["synced"] = false; return entry }
            entry["synced"] = true
            entry["uploaded"] = upload.uploaded
            entry["uploading"] = upload.uploading
            switch cloud.freshness(of: url) {
            case .notDownloaded: entry["download"] = "not-downloaded"
            case .stale: entry["download"] = "stale"
            case .current: entry["download"] = "current"
            case nil: entry["download"] = "unknown"
            }
            entry["conflicts"] = conflicts.hasUnresolvedConflicts(url)
            return entry
        }
    }

    /// Lists the files iCloud holds set-aside versions for, from metadata alone.
    private func scan(_ request: [String: Any]) throws -> [String: Any] {
        let root = try root(request)
        guard let walker = fm.enumerator(at: root, includingPropertiesForKeys: [.isRegularFileKey, .ubiquitousItemHasUnresolvedConflictsKey], options: [.skipsHiddenFiles, .skipsPackageDescendants], errorHandler: { _, _ in true }) else { throw StorageFailure("io") }
        var conflicted: [String] = [], seen = 0, truncated = false
        let prefix = root.path.hasSuffix("/") ? root.path : root.path + "/"
        for case let url as URL in walker {
            seen += 1
            if seen > Self.scanLimit { truncated = true; break }
            guard (try? url.resourceValues(forKeys: [.isRegularFileKey]))?.isRegularFile == true, conflicts.hasUnresolvedConflicts(url) else { continue }
            let path = url.standardizedFileURL.path
            if path.hasPrefix(prefix) { conflicted.append(String(path.dropFirst(prefix.count))) }
        }
        return ["synced": cloud.upload(of: root) != nil, "conflicted": conflicted.sorted(), "truncated": truncated]
    }

    /// Whether the folder, or a folder above it, is a git working tree.
    private func insideGitRepository(_ folder: URL) -> Bool {
        var cursor = folder.standardizedFileURL
        for _ in 0..<64 {
            if fm.fileExists(atPath: cursor.appendingPathComponent(".git").path) { return true }
            let parent = cursor.deletingLastPathComponent()
            if parent.path == cursor.path { break }
            cursor = parent
        }
        return false
    }

    private func harvest(_ request: [String: Any]) throws -> [String: Any] {
        let disk = DiskConflictFiles(root: try root(request))
        guard let path = request["path"] as? String, !path.isEmpty, path.utf8.count <= 4096, let url = disk.url(for: path) else { throw StorageFailure("invalid-path") }
        var directory: ObjCBool = false
        guard fm.fileExists(atPath: url.path, isDirectory: &directory) else { throw StorageFailure("not-found") }
        guard !directory.boolValue else { throw StorageFailure("type-mismatch") }
        let outcome = ConflictHarvester(files: disk.files, source: conflicts, gitIgnore: insideGitRepository(try root(request))).harvest(path, at: url)
        return ["kept": outcome.kept, "duplicates": outcome.duplicates, "pending": outcome.pending]
    }
}
