import Foundation
import CryptoKit
import Darwin

public struct StorageFailure: Error {
    public let code: String
    public init(_ code: String) { self.code = code }
}

/// One instance per WebView. The lock includes compare, mutation and snapshot.
/// Registered roots and transfer ownership never come from renderer paths.
public final class Storage {
    public static let fileBytes = 16 * 1024 * 1024
    public static let chunkBytes = 256 * 1024
    public static let totalBytes = 32 * 1024 * 1024
    public static let capabilities: [String: Any] = ["writeAtomicity": "process", "moveAtomicity": "process", "snapshotAtomicity": "process", "conditionalWrite": "process", "recursiveRemove": true, "watch": false, "caseSensitivity": "platform", "symlinkPolicy": "reject", "durability": "best-effort"]
    private let lock = NSRecursiveLock()
    private let fm = FileManager.default
    private var roots: [String: URL]
    private var rootIdentities: [String: String] = [:]
    private var instances: [String: String] = [:]
    private struct Transfer {
        let owner: String
        let path: String
        let size: Int
        let options: [String: Any]
        let writing: Bool
        let created: Date
        var touched: Date
        var data: Data
    }
    private var transfers: [String: Transfer] = [:]
    private var dead = false

    public init(roots: [String: URL]) throws {
        self.roots = roots.mapValues { $0.standardizedFileURL.resolvingSymlinksInPath() }
        for root in self.roots.values {
            let attrs = try fm.attributesOfItem(atPath: root.path)
            guard attrs[.type] as? FileAttributeType == .typeDirectory else { throw StorageFailure("type-mismatch") }
        }
        for (id, root) in self.roots { rootIdentities[id] = try identity(root) }
    }
    private func identity(_ root: URL) throws -> String {
        let attributes = try fm.attributesOfItem(atPath: root.path)
        guard attributes[.type] as? FileAttributeType == .typeDirectory else { throw StorageFailure("permission-denied") }
        return "\(attributes[.systemNumber] ?? ""):\(attributes[.systemFileNumber] ?? "")"
    }
    public func register(_ id: String, root: URL) throws {
        lock.lock(); defer { lock.unlock() }
        guard !dead, roots.count < 64 else { throw StorageFailure("busy") }
        let canonical = root.standardizedFileURL.resolvingSymlinksInPath()
        let pinned = try identity(canonical)
        roots[id] = canonical; rootIdentities[id] = pinned
    }
    public func importDocument(_ source: URL) throws -> String {
        lock.lock(); defer { lock.unlock() }
        guard !dead, let root = roots["local"], ["md", "markdown"].contains(source.pathExtension.lowercased()) else { throw StorageFailure("not-supported") }
        let name = source.lastPathComponent
        try canonical(name); guard !name.contains("/"), name.utf16.count <= 255 else { throw StorageFailure("invalid-path") }
        let bytes = try readBytes(source)
        let path = "Inbox/" + UUID().uuidString + "/" + name
        _ = try write(root, path, bytes, ["mode": "create", "createParents": true]); return path
    }
    public func unregister(_ id: String) {
        lock.lock(); defer { lock.unlock() }
        roots.removeValue(forKey: id); rootIdentities.removeValue(forKey: id)
        for (instance, root) in instances where root == id { instances.removeValue(forKey: instance); transfers = transfers.filter { $0.value.owner != instance } }
    }
    public func shutdown() {
        lock.lock(); defer { lock.unlock() }
        dead = true; instances.removeAll(); transfers.removeAll()
    }
    public func request(_ input: Any) -> [String: Any] {
        lock.lock(); defer { lock.unlock() }
        do {
            guard !dead else { throw StorageFailure("disposed") }
            let r = try object(input)
            let value: Any
            if let owner = r["instanceId"] as? String, let provider = instances[owner], provider != "local", let root = roots[provider] {
                var failure: NSError?, result: Result<Any, Error>?
                NSFileCoordinator().coordinate(writingItemAt: root, options: .forMerging, error: &failure) { coordinated in
                    result = Result {
                        guard coordinated.standardizedFileURL.resolvingSymlinksInPath() == root, try self.identity(root) == self.rootIdentities[provider] else { throw StorageFailure("permission-denied") }
                        return try self.dispatch(r)
                    }
                }
                if let failure { throw failure }
                guard let result else { throw StorageFailure("io") }
                value = try result.get()
            } else { value = try dispatch(r) }
            return ["ok": true, "value": value]
        } catch {
            let code: String
            if let failure = error as? StorageFailure { code = failure.code }
            else {
                let ns = error as NSError
                if ns.domain == NSCocoaErrorDomain {
                    switch ns.code {
                    case NSFileReadNoSuchFileError, NSFileNoSuchFileError: code = "not-found"
                    case NSFileReadNoPermissionError, NSFileWriteNoPermissionError: code = "permission-denied"
                    case NSFileWriteOutOfSpaceError: code = "quota-exceeded"
                    case NSFileWriteFileExistsError: code = "already-exists"
                    default: code = "io"
                    }
                } else { code = "io" }
            }
            return ["ok": false, "error": ["name": "FsError", "code": code, "message": "Native storage: \(code).", "operation": NSNull(), "path": NSNull(), "destinationPath": NSNull(), "retryable": ["io", "busy", "aborted"].contains(code)]]
        }
    }
    private func object(_ value: Any) throws -> [String: Any] {
        guard let result = value as? [String: Any] else { throw StorageFailure("corrupt") }; return result
    }
    private func exact(_ r: [String: Any], _ keys: [String], optional: [String] = []) throws {
        guard Set(keys).isSubset(of: Set(r.keys)), Set(r.keys).isSubset(of: Set(keys + optional)) else { throw StorageFailure("corrupt") }
    }
    private func string(_ r: [String: Any], _ key: String, maximum: Int = 4096) throws -> String {
        guard let value = r[key] as? String, value.utf16.count <= maximum, !value.contains("\0") else { throw StorageFailure("corrupt") }; return value
    }
    private func identifier(_ r: [String: Any], _ key: String) throws -> String {
        let value = try string(r, key, maximum: 256)
        guard !value.isEmpty, value.range(of: "^[a-zA-Z0-9_-]+$", options: .regularExpression) != nil else { throw StorageFailure("corrupt") }; return value
    }
    private func number(_ r: [String: Any], _ key: String, maximum: Int) throws -> Int {
        guard let n = r[key] as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID(), n.doubleValue.isFinite, n.doubleValue.rounded() == n.doubleValue, n.doubleValue >= 0, n.doubleValue <= Double(maximum) else { throw StorageFailure("corrupt") }; return n.intValue
    }
    private func options(_ r: [String: Any], _ op: String) throws -> [String: Any] {
        let opts = try object(r["options"] as Any)
        let keys: [String]
        switch op { case "writeBegin": keys = ["mode", "createParents", "expectedVersion"]
        case "mkdir": keys = ["mode", "createParents"]
        case "remove": keys = ["recursive", "missing", "expectedVersion"]
        default: keys = ["createParents", "expectedVersion"] }
        try exact(opts, [], optional: keys)
        for key in ["createParents", "recursive"] where opts[key] != nil {
            guard let n = opts[key] as? NSNumber, CFGetTypeID(n) == CFBooleanGetTypeID() else { throw StorageFailure("corrupt") }
        }
        if let mode = opts["mode"] { guard let s = mode as? String, (op == "mkdir" ? ["ensure", "create"] : ["upsert", "create", "replace"]).contains(s) else { throw StorageFailure("corrupt") } }
        if let missing = opts["missing"] { guard let s = missing as? String, ["ignore", "error"].contains(s) else { throw StorageFailure("corrupt") } }
        if let version = opts["expectedVersion"] {
            if !(version is NSNull && op == "writeBegin") { guard let s = version as? String, !s.isEmpty, s.utf16.count <= 1024, !s.contains("\0") else { throw StorageFailure("corrupt") } }
        }
        return opts
    }
    private func canonical(_ path: String) throws {
        guard path.utf16.count <= 4096, path.unicodeScalars.allSatisfy({ $0.value >= 32 && $0.value != 127 }), !path.contains("\\"), !path.hasPrefix("/"), !path.hasSuffix("/"), path.range(of: "^[a-zA-Z]:", options: .regularExpression) == nil else { throw StorageFailure("invalid-path") }
        if !path.isEmpty { guard path.split(separator: "/", omittingEmptySubsequences: false).allSatisfy({ !$0.isEmpty && $0 != "." && $0 != ".." }), path.split(separator: "/").count <= 128 else { throw StorageFailure("invalid-path") } }
    }
    private func attributes(_ url: URL) throws -> [FileAttributeKey: Any]? {
        do { return try fm.attributesOfItem(atPath: url.path) }
        catch { let e = error as NSError; if e.domain == NSCocoaErrorDomain && [NSFileNoSuchFileError, NSFileReadNoSuchFileError].contains(e.code) { return nil }; throw error }
    }
    private func resolve(_ root: URL, _ path: String) throws -> URL {
        try canonical(path)
        var url = root
        let parts = path.isEmpty ? [] : path.split(separator: "/").map(String.init)
        for (index, part) in ([""] + parts).enumerated() {
            if !part.isEmpty { url.appendPathComponent(part) }
            if let attrs = try attributes(url) {
                guard attrs[.type] as? FileAttributeType != .typeSymbolicLink else { throw StorageFailure("path-escape") }
                if index < parts.count { guard attrs[.type] as? FileAttributeType == .typeDirectory else { throw StorageFailure("type-mismatch") } }
            }
        }
        guard url.standardizedFileURL.path == root.path || url.standardizedFileURL.path.hasPrefix(root.path + "/") else { throw StorageFailure("path-escape") }
        return url
    }
    private func readBytes(_ url: URL) throws -> Data {
        let handle = try FileHandle(forReadingFrom: url); defer { try? handle.close() }
        var bytes = Data()
        while let chunk = try handle.read(upToCount: Self.chunkBytes), !chunk.isEmpty {
            guard bytes.count + chunk.count <= Self.fileBytes else { throw StorageFailure("quota-exceeded") }
            bytes.append(chunk)
        }
        return bytes
    }
    private func names(_ url: URL) throws -> [String] {
        var names: [String] = [], failure: Error?
        guard let enumerator = fm.enumerator(at: url, includingPropertiesForKeys: nil, options: [.skipsSubdirectoryDescendants], errorHandler: { _, error in failure = error; return false }) else { throw StorageFailure("io") }
        while let item = enumerator.nextObject() as? URL {
            guard names.count < 10_000 else { throw StorageFailure("quota-exceeded") }; names.append(item.lastPathComponent)
        }
        if let failure { throw failure }
        return names.sorted()
    }
    private func hash(_ data: Data) -> String { SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }
    private struct Budget { var bytes = 0; var entries = 0 }
    private func scan(_ root: URL, _ path: String, budget: inout Budget, includeBytes: Bool = false) throws -> [[String: Any]] {
        budget.entries += 1; guard budget.entries <= 10_000 else { throw StorageFailure("quota-exceeded") }
        let url = try resolve(root, path)
        guard let attrs = try attributes(url) else { return [] }
        let kind = attrs[.type] as? FileAttributeType
        guard kind == .typeRegular || kind == .typeDirectory else { throw StorageFailure("not-supported") }
        let date = (attrs[.modificationDate] as? Date) ?? Date(timeIntervalSince1970: 0)
        let iso = ISO8601DateFormatter(); iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        var entry: [String: Any] = ["path": path, "name": path.isEmpty ? "" : url.lastPathComponent, "lastModified": iso.string(from: date), "kind": kind == .typeRegular ? "file" : "directory"]
        if kind == .typeRegular {
            let size = (attrs[.size] as? NSNumber)?.intValue ?? 0
            guard size <= Self.fileBytes, budget.bytes + size <= Self.totalBytes else { throw StorageFailure("quota-exceeded") }
            let data = try readBytes(url)
            guard data.count <= Self.fileBytes, budget.bytes + data.count <= Self.totalBytes else { throw StorageFailure("quota-exceeded") }
            budget.bytes += data.count; entry["size"] = data.count; entry["version"] = hash(data)
            if includeBytes { entry["data"] = data.base64EncodedString() }
            return [entry]
        }
        let names = try names(url)
        guard names.count <= 10_000 else { throw StorageFailure("quota-exceeded") }
        var children: [[String: Any]] = []
        var fingerprints: [[String]] = []
        for name in names {
            let childPath = path.isEmpty ? name : path + "/" + name
            let tree = try scan(root, childPath, budget: &budget, includeBytes: includeBytes)
            guard let child = tree.first else { throw StorageFailure("conflict") }
            fingerprints.append([name, child["kind"] as! String, child["version"] as! String]); children += tree
        }
        entry["size"] = NSNull(); entry["version"] = hash(try JSONSerialization.data(withJSONObject: fingerprints))
        return [entry] + children
    }
    private func stat(_ root: URL, _ path: String) throws -> [String: Any]? { var b = Budget(); return try scan(root, path, budget: &b).first }
    private func expected(_ opts: [String: Any], _ current: [String: Any]?) throws {
        if let value = opts["expectedVersion"] {
            if value is NSNull { guard current == nil else { throw StorageFailure("conflict") } }
            else { guard let current, current["version"] as? String == value as? String else { throw StorageFailure("conflict") } }
        }
    }
    private func parents(_ root: URL, _ path: String, create: Bool) throws -> [URL] {
        let parent = try resolve(root, path).deletingLastPathComponent()
        var missing: [URL] = []; var cursor = parent
        while try cursor.path != root.path && attributes(cursor) == nil { missing.append(cursor); cursor.deleteLastPathComponent() }
        if !missing.isEmpty && !create { throw StorageFailure("not-found") }
        guard try attributes(cursor)?[.type] as? FileAttributeType == .typeDirectory else { throw StorageFailure("type-mismatch") }
        var created: [URL] = []
        do { for url in missing.reversed() { try fm.createDirectory(at: url, withIntermediateDirectories: false); created.append(url) }; return created }
        catch { rollback(created); throw error }
    }
    private func rollback(_ urls: [URL]) { for url in urls.reversed() { if (try? fm.contentsOfDirectory(atPath: url.path).isEmpty) == true { try? fm.removeItem(at: url) } } }
    private func write(_ root: URL, _ path: String, _ data: Data, _ opts: [String: Any]) throws -> [String: Any] {
        guard !path.isEmpty else { throw StorageFailure("invalid-path") }
        let url = try resolve(root, path); let current = try stat(root, path)
        try expected(opts, current)
        let mode = opts["mode"] as? String ?? "upsert"
        if mode == "create" && current != nil { throw StorageFailure("already-exists") }
        if mode == "replace" && current == nil { throw StorageFailure("not-found") }
        if current != nil && current?["kind"] as? String != "file" { throw StorageFailure("type-mismatch") }
        let created = try parents(root, path, create: opts["createParents"] as? Bool ?? false)
        let temporary = url.deletingLastPathComponent().appendingPathComponent(".docblocks-" + UUID().uuidString)
        defer { try? fm.removeItem(at: temporary) }
        do {
            try data.write(to: temporary, options: .withoutOverwriting)
            let handle = try FileHandle(forWritingTo: temporary); defer { try? handle.close() }; try handle.synchronize()
            let status = mode == "create" || current == nil ? link(temporary.path, url.path) : rename(temporary.path, url.path)
            if status != 0 {
                if (current == nil || mode == "create") && [EPERM, ENOTSUP, EXDEV].contains(errno) { try fm.moveItem(at: temporary, to: url) }
                else { throw StorageFailure(errno == EEXIST ? "already-exists" : errno == ENOSPC ? "quota-exceeded" : errno == EACCES ? "permission-denied" : "io") }
            }
            return try stat(root, path)!
        }
        catch { try? fm.removeItem(at: temporary); rollback(created); throw error }
    }
    private func dispatch(_ r: [String: Any]) throws -> Any {
        let op = try string(r, "op", maximum: 32)
        let owner = try identifier(r, "instanceId")
        let now = Date()
        transfers = transfers.filter { now.timeIntervalSince($0.value.created) < 900 && now.timeIntervalSince($0.value.touched) < 120 }
        if op == "open" {
            try exact(r, ["op", "instanceId", "providerId", "label"])
            let provider = try identifier(r, "providerId"); _ = try string(r, "label", maximum: 1024)
            guard roots[provider] != nil else { throw StorageFailure("permission-denied") }
            guard instances[owner] == nil || instances[owner] == provider else { throw StorageFailure("permission-denied") }
            guard instances.count < 128 || instances[owner] != nil else { throw StorageFailure("busy") }
            instances[owner] = provider; return Self.capabilities
        }
        if op == "dispose" {
            try exact(r, ["op", "instanceId"]); instances.removeValue(forKey: owner); transfers = transfers.filter { $0.value.owner != owner }; return NSNull()
        }
        guard let provider = instances[owner], let root = roots[provider] else { throw StorageFailure("disposed") }
        do { guard try identity(root) == rootIdentities[provider] else { throw StorageFailure("permission-denied") } }
        catch {
            let nativeError = error as NSError
            if nativeError.domain == NSCocoaErrorDomain && [NSFileNoSuchFileError, NSFileReadNoSuchFileError].contains(nativeError.code) { throw StorageFailure("permission-denied") }
            throw error
        }
        switch op {
        case "stat", "list", "readBegin":
            try exact(r, ["op", "instanceId", "path"])
            let path = try string(r, "path"); let url = try resolve(root, path)
            if op == "stat" { return try stat(root, path) as Any? ?? NSNull() }
            if op == "list" {
                guard let current = try stat(root, path) else { throw StorageFailure("not-found") }
                guard current["kind"] as? String == "directory" else { throw StorageFailure("type-mismatch") }
                return try names(url).map { name -> [String: Any] in guard let item = try stat(root, path.isEmpty ? name : path + "/" + name) else { throw StorageFailure("conflict") }; return item }.sorted { a, b in
                    let ak = a["kind"] as! String, bk = b["kind"] as! String
                    return ak == bk ? (a["name"] as! String) < (b["name"] as! String) : ak == "directory"
                }
            }
            guard var item = try stat(root, path) else { return NSNull() }
            guard item["kind"] as? String == "file" else { throw StorageFailure("type-mismatch") }
            let data = try readBytes(url); guard data.count <= Self.fileBytes else { throw StorageFailure("quota-exceeded") }
            item["version"] = hash(data); item["size"] = data.count
            let token = try addTransfer(owner, path, data.count, [:], false, data)
            return ["transferId": token, "entry": item]
        case "writeBegin":
            try exact(r, ["op", "instanceId", "path", "byteLength", "options"])
            let path = try string(r, "path"); _ = try resolve(root, path)
            guard !path.isEmpty else { throw StorageFailure("invalid-path") }
            let size = try number(r, "byteLength", maximum: Self.fileBytes)
            return try addTransfer(owner, path, size, options(r, op), true, Data())
        case "readChunk", "writeChunk", "writeFinish", "closeTransfer":
            let keys = ["op", "instanceId", "transferId"] + (op == "readChunk" ? ["offset"] : op == "writeChunk" ? ["offset", "data"] : [])
            try exact(r, keys); let token = try identifier(r, "transferId")
            if op == "closeTransfer" && transfers[token] == nil { return NSNull() }
            guard var transfer = transfers[token], transfer.owner == owner else { throw StorageFailure("permission-denied") }
            if op == "closeTransfer" { transfers.removeValue(forKey: token); return NSNull() }
            transfer.touched = now
            if op == "readChunk" {
                guard !transfer.writing else { throw StorageFailure("corrupt") }
                let offset = try number(r, "offset", maximum: transfer.size)
                transfers[token] = transfer
                return transfer.data.subdata(in: offset..<min(offset + Self.chunkBytes, transfer.size)).base64EncodedString()
            }
            guard transfer.writing else { throw StorageFailure("corrupt") }
            if op == "writeChunk" {
                let offset = try number(r, "offset", maximum: Self.fileBytes)
                let base64 = try string(r, "data", maximum: ((Self.chunkBytes + 2) / 3) * 4)
                guard let data = Data(base64Encoded: base64), data.base64EncodedString() == base64, data.count <= Self.chunkBytes, offset == transfer.data.count, offset + data.count <= transfer.size else { throw StorageFailure("corrupt") }
                transfer.data.append(data); transfers[token] = transfer; return NSNull()
            }
            transfers.removeValue(forKey: token)
            guard transfer.data.count == transfer.size else { throw StorageFailure("corrupt") }
            return try write(root, transfer.path, transfer.data, transfer.options)
        case "mkdir":
            try exact(r, ["op", "instanceId", "path", "options"])
            let path = try string(r, "path"), opts = try options(r, op), url = try resolve(root, path)
            if let current = try stat(root, path) {
                guard opts["mode"] as? String != "create" else { throw StorageFailure(path.isEmpty ? "invalid-path" : "already-exists") }
                guard current["kind"] as? String == "directory" else { throw StorageFailure("type-mismatch") }; return current
            }
            let created = try parents(root, path, create: opts["createParents"] as? Bool ?? false)
            do { try fm.createDirectory(at: url, withIntermediateDirectories: false); return try stat(root, path)! } catch { rollback(created); throw error }
        case "remove":
            try exact(r, ["op", "instanceId", "path", "options"])
            let path = try string(r, "path"), opts = try options(r, op), url = try resolve(root, path)
            guard !path.isEmpty else { throw StorageFailure("invalid-path") }
            let current = try stat(root, path); try expected(opts, current)
            if current == nil { guard opts["missing"] as? String == "ignore" else { throw StorageFailure("not-found") } }
            else {
                if try current?["kind"] as? String == "directory" && opts["recursive"] as? Bool != true && !fm.contentsOfDirectory(atPath: url.path).isEmpty { throw StorageFailure("not-empty") }
                try fm.removeItem(at: url)
            }
            return ["removed": current != nil, "version": try stat(root, "")!["version"]!]
        case "move":
            try exact(r, ["op", "instanceId", "oldPath", "newPath", "options"])
            let old = try string(r, "oldPath"), new = try string(r, "newPath"), opts = try options(r, op)
            guard !old.isEmpty, !new.isEmpty, !new.hasPrefix(old + "/") else { throw StorageFailure("invalid-path") }
            let source = try resolve(root, old), destination = try resolve(root, new)
            guard let current = try stat(root, old) else { throw StorageFailure("not-found") }
            try expected(opts, current)
            if old == new { return current }
            guard try attributes(destination) == nil else { throw StorageFailure("already-exists") }
            let created = try parents(root, new, create: opts["createParents"] as? Bool ?? false)
            do { try fm.moveItem(at: source, to: destination); return try stat(root, new)! } catch { rollback(created); throw error }
        case "snapshot":
            try exact(r, ["op", "instanceId"]); var b = Budget()
            let entries = try scan(root, "", budget: &b, includeBytes: true).sorted { ($0["path"] as! String) < ($1["path"] as! String) }
            return ["version": entries[0]["version"]!, "entries": entries]
        default: throw StorageFailure("not-supported")
        }
    }
    private func addTransfer(_ owner: String, _ path: String, _ size: Int, _ options: [String: Any], _ writing: Bool, _ data: Data) throws -> String {
        guard transfers.count < 4, transfers.values.reduce(0, { $0 + $1.size }) + size <= Self.totalBytes else { throw StorageFailure("busy") }
        let id = UUID().uuidString
        transfers[id] = Transfer(owner: owner, path: path, size: size, options: options, writing: writing, created: Date(), touched: Date(), data: data)
        return id
    }
}
