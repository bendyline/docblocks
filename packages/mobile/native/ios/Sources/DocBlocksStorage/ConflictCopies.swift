import Foundation
import CryptoKit
import Darwin

/// One version of a file that iCloud set aside when two devices saved it.
public struct LosingVersion {
    public let device: String?
    public let modified: Date?
    public let read: () throws -> Data
    public let markResolved: () -> Void
    public init(device: String?, modified: Date?, read: @escaping () throws -> Data, markResolved: @escaping () -> Void) {
        self.device = device; self.modified = modified; self.read = read; self.markResolved = markResolved
    }
}

/// The seam between harvesting and iCloud's version store, so tests can script it.
public protocol ConflictVersionSource {
    /// A cheap check that is safe to make for every listed file.
    func hasUnresolvedConflicts(_ url: URL) -> Bool
    func losingVersions(of url: URL) -> [LosingVersion]
    /// Lets iCloud drop the versions already marked resolved.
    func discardResolved(of url: URL) throws
}

public struct SystemConflictVersions: ConflictVersionSource {
    public init() {}
    public func hasUnresolvedConflicts(_ url: URL) -> Bool {
        (try? URL(fileURLWithPath: url.path).resourceValues(forKeys: [.ubiquitousItemHasUnresolvedConflictsKey]))?.ubiquitousItemHasUnresolvedConflicts == true
    }
    public func losingVersions(of url: URL) -> [LosingVersion] {
        (NSFileVersion.unresolvedConflictVersionsOfItem(at: url) ?? []).map { version in
            LosingVersion(device: version.localizedNameOfSavingComputer, modified: version.modificationDate,
                          read: { try Data(contentsOf: version.url, options: .mappedIfSafe) },
                          markResolved: { version.isResolved = true })
        }
    }
    public func discardResolved(of url: URL) throws { try NSFileVersion.removeOtherVersionsOfItem(at: url) }
}

/// The file name of a conflict copy. Mirrors `packages/core/src/filesystem/conflict-copies.ts`;
/// `packages/core/test/fixtures/conflict-copy-names.json` pins both.
public struct ConflictCopyName: Equatable {
    public var capturedAt: Date
    public var origin: String
    public var source: Bool
    public var hash: String
    public var label: String?
    public var fileExtension: String
    public init(capturedAt: Date, origin: String, source: Bool, hash: String, label: String?, fileExtension: String) {
        self.capturedAt = capturedAt; self.origin = origin; self.source = source; self.hash = hash; self.label = label; self.fileExtension = fileExtension
    }
    public static let origins = ["sync", "local", "draft", "premerge"]
    private static let pattern = try! NSRegularExpression(pattern: "^(\\d{4})(\\d{2})(\\d{2})T(\\d{2})(\\d{2})(\\d{2})Z-(sync|local|draft|premerge)(-s)?-([0-9a-f]{16})(?: \\((.+)\\))?(\\.[A-Za-z0-9]{1,16})?$")
    private static var utc: Calendar { var calendar = Calendar(identifier: .gregorian); calendar.timeZone = TimeZone(identifier: "UTC")!; return calendar }

    /// First 16 hex digits of the content's SHA-256.
    public static func hash(_ data: Data) -> String {
        SHA256.hash(data: data).prefix(8).map { String(format: "%02x", $0) }.joined()
    }
    /// A device name made safe inside a file name on every platform a folder can sync to.
    public static func label(_ raw: String?) -> String? {
        guard let raw, !raw.isEmpty else { return nil }
        let banned = Set("/\\:*?\"<>|".unicodeScalars)
        var cleaned = String.UnicodeScalarView()
        var spaced = false
        for scalar in raw.unicodeScalars where scalar.value >= 32 && !(127...159).contains(scalar.value) && !banned.contains(scalar) {
            // JavaScript's \s, so both sides collapse the same runs.
            let space = scalar.properties.isWhitespace || scalar.value == 0xFEFF
            if space { if !spaced { cleaned.append(" ") }; spaced = true } else { cleaned.append(scalar); spaced = false }
        }
        func trimmed(_ value: String.UnicodeScalarView) -> String.UnicodeScalarView {
            var view = value
            while let first = view.first, first == " " || first == "." { view.removeFirst() }
            while let last = view.last, last == " " || last == "." { view.removeLast() }
            return view
        }
        let bounded = trimmed(String.UnicodeScalarView(trimmed(cleaned).prefix(40)))
        return bounded.isEmpty ? nil : String(bounded)
    }
    public func format() -> String? {
        guard Self.origins.contains(origin), hash.range(of: "^[0-9a-f]{16}$", options: .regularExpression) != nil,
              fileExtension.isEmpty || fileExtension.range(of: "^\\.[A-Za-z0-9]{1,16}$", options: .regularExpression) != nil else { return nil }
        let parts = Self.utc.dateComponents([.year, .month, .day, .hour, .minute, .second], from: capturedAt)
        guard let year = parts.year, let month = parts.month, let day = parts.day, let hour = parts.hour, let minute = parts.minute, let second = parts.second, (0...9999).contains(year) else { return nil }
        let stamp = String(format: "%04d%02d%02dT%02d%02d%02dZ", year, month, day, hour, minute, second)
        let device = Self.label(label).map { " (\($0))" } ?? ""
        return "\(stamp)-\(origin)\(source ? "-s" : "")-\(hash)\(device)\(fileExtension)"
    }
    public static func parse(_ name: String) -> ConflictCopyName? {
        let whole = NSRange(name.startIndex..., in: name)
        guard let match = pattern.firstMatch(in: name, range: whole) else { return nil }
        func group(_ index: Int) -> String? { Range(match.range(at: index), in: name).map { String(name[$0]) } }
        var parts = DateComponents()
        parts.year = Int(group(1)!); parts.month = Int(group(2)!); parts.day = Int(group(3)!)
        parts.hour = Int(group(4)!); parts.minute = Int(group(5)!); parts.second = Int(group(6)!)
        // A stamp such as February 30 is not a date; reject it instead of rolling it over.
        guard parts.isValidDate(in: utc), let date = utc.date(from: parts) else { return nil }
        return ConflictCopyName(capturedAt: date, origin: group(7)!, source: group(8) != nil, hash: group(9)!, label: group(10), fileExtension: group(11) ?? "")
    }
}

/// Where a losing version of a file belongs.
public enum ConflictPlacement: Equatable {
    /// A document: `<stem>_files/conflicts`, shown to the user for review.
    case sidecar(directory: String, source: Bool)
    /// Something inside a sidecar that is not a document: kept, never shown.
    case other(directory: String)
    /// A file with no sidecar: a visible copy beside it.
    case sibling
}

/// Moves the versions iCloud set aside into the document's sidecar. Shared by the iPhone and iPad
/// storage layer and the Mac helper; each supplies its own way to reach files under one root.
public struct ConflictHarvester {
    /// File access relative to one root, with forward-slash paths.
    public struct Files {
        public var isDirectory: (String) throws -> Bool
        public var names: (String) throws -> [String]
        public var read: (String) throws -> Data
        /// Creates a new file and any missing parents. Never replaces an existing file.
        public var create: (String, Data) throws -> Void
        public init(isDirectory: @escaping (String) throws -> Bool, names: @escaping (String) throws -> [String], read: @escaping (String) throws -> Data, create: @escaping (String, Data) throws -> Void) {
            self.isDirectory = isDirectory; self.names = names; self.read = read; self.create = create
        }
    }
    public struct Outcome: Equatable {
        /// Copies written by this call.
        public var kept = 0
        /// Versions that needed no copy: identical to the file or to a copy already kept.
        public var duplicates = 0
        /// Versions that could not be copied. They stay with iCloud for another attempt.
        public var pending = 0
        public init() {}
    }
    public static let directoryName = "conflicts"
    public static let otherDirectoryName = "other"
    private static let markdown = ["md", "markdown", "mdown"]
    private static let rendered = ["html", "htm", "docx", "pdf", "pptx", "xlsx", "csv"]
    private let files: Files
    private let source: ConflictVersionSource
    private let now: () -> Date
    private let gitIgnore: Bool
    /// `gitIgnore`: the folder is a git repository, so the copies get a `.gitignore`. Elsewhere none
    /// is written: two devices that set a version aside at the same moment would each create that
    /// same file, which is one more conflict for the sync service to settle.
    public init(files: Files, source: ConflictVersionSource, gitIgnore: Bool = false, now: @escaping () -> Date = Date.init) {
        self.files = files; self.source = source; self.gitIgnore = gitIgnore; self.now = now
    }

    private static func split(_ path: String) -> (parent: String, name: String) {
        guard let slash = path.lastIndex(of: "/") else { return ("", path) }
        return (String(path[..<slash]), String(path[path.index(after: slash)...]))
    }
    private static func join(_ parent: String, _ child: String) -> String { parent.isEmpty ? child : parent + "/" + child }
    private static func parts(_ name: String) -> (stem: String, ext: String) {
        guard let dot = name.lastIndex(of: "."), dot != name.startIndex, name.index(after: dot) != name.endIndex else { return (name, "") }
        return (String(name[..<dot]), String(name[name.index(after: dot)...]))
    }
    /// The extension a copy keeps, with its dot; empty when it would not be a plain extension.
    private static func copyExtension(_ name: String) -> String {
        let ext = parts(name).ext
        return ext.range(of: "^[A-Za-z0-9]{1,16}$", options: .regularExpression) != nil ? "." + ext : ""
    }

    public func placement(for path: String) throws -> ConflictPlacement {
        let (parent, name) = Self.split(path)
        let (stem, ext) = Self.parts(name)
        let isMarkdown = Self.markdown.contains(ext.lowercased()) && !stem.isEmpty
        let ancestors = parent.isEmpty ? [] : parent.split(separator: "/").map(String.init)
        if let last = ancestors.last, last.hasSuffix("_files"), isMarkdown {
            // The Markdown source of a document that is published as another format.
            return .sidecar(directory: Self.join(parent, Self.directoryName), source: true)
        }
        if let index = ancestors.lastIndex(where: { $0.hasSuffix("_files") }) {
            let sidecar = ancestors[...index].joined(separator: "/")
            return .other(directory: Self.join(Self.join(sidecar, Self.directoryName), Self.otherDirectoryName))
        }
        let sidecar = Self.join(parent, stem + "_files")
        if isMarkdown { return .sidecar(directory: Self.join(sidecar, Self.directoryName), source: false) }
        if Self.rendered.contains(ext.lowercased()), (try? files.isDirectory(sidecar)) == true {
            return .other(directory: Self.join(Self.join(sidecar, Self.directoryName), Self.otherDirectoryName))
        }
        return .sibling
    }

    /// Keeps every losing version of `path` that holds something the file and its existing copies
    /// do not. A version that cannot be copied is left with iCloud, never dropped.
    @discardableResult
    public func harvest(_ path: String, at url: URL) -> Outcome {
        var outcome = Outcome()
        let versions = source.losingVersions(of: url)
        guard !versions.isEmpty else { return outcome }
        let current = (try? files.read(path)).map(ConflictCopyName.hash)
        let placement = (try? self.placement(for: path)) ?? .sibling
        let (parent, name) = Self.split(path)
        for version in versions {
            do {
                let data = try version.read()
                let hash = ConflictCopyName.hash(data)
                if hash == current { version.markResolved(); outcome.duplicates += 1; continue }
                let written: Bool
                switch placement {
                case .sidecar(let directory, let isSource):
                    written = try keep(data, hash: hash, in: directory, ignoring: directory, source: isSource, label: version.device, ext: Self.copyExtension(name), modified: version.modified)
                case .other(let directory):
                    // Named for the file it came from; nothing reads these names back.
                    written = try keep(data, hash: hash, in: directory, ignoring: Self.split(directory).parent, source: false, label: Self.parts(name).stem, ext: Self.copyExtension(name), modified: version.modified)
                case .sibling:
                    written = try keepBeside(data, parent: parent, name: name, device: version.device, modified: version.modified)
                }
                version.markResolved()
                if written { outcome.kept += 1 } else { outcome.duplicates += 1 }
            } catch { outcome.pending += 1 }
        }
        // Discarding also drops unresolved versions, so only when every one has been dealt with.
        if outcome.pending == 0 { try? source.discardResolved(of: url) }
        return outcome
    }

    private func keep(_ data: Data, hash: String, in directory: String, ignoring conflicts: String, source isSource: Bool, label: String?, ext: String, modified: Date?) throws -> Bool {
        let existing = (try? files.isDirectory(directory)) == true ? try files.names(directory) : []
        let duplicate = existing.contains { candidate in
            guard let parsed = ConflictCopyName.parse(candidate) else { return false }
            // A copy held only to undo a merge expires, so it never stands in for one awaiting review.
            return parsed.hash == hash && parsed.source == isSource && parsed.origin != "premerge" && parsed.fileExtension.lowercased() == ext.lowercased()
        }
        if duplicate { return false }
        guard let name = ConflictCopyName(capturedAt: modified ?? now(), origin: "sync", source: isSource, hash: hash, label: label, fileExtension: ext).format(), name.utf8.count <= 255 else { throw StorageFailure("conflict") }
        // Git has no use for these, and committing them would hand one person's conflict to a team.
        let ignore = Self.join(conflicts, ".gitignore")
        if gitIgnore, (try? files.read(ignore)) == nil { try? files.create(ignore, Data("*\n".utf8)) }
        try files.create(Self.join(directory, name), data)
        return true
    }

    /// The copy for a file with no sidecar: visible beside it, as before, but never the same bytes twice.
    private func keepBeside(_ data: Data, parent: String, name: String, device: String?, modified: Date?) throws -> Bool {
        let (stem, ext) = Self.parts(name)
        let suffix = ext.isEmpty ? "" : "." + ext
        let marker = stem + " (conflict from "
        for candidate in try files.names(parent) where candidate.hasPrefix(marker) && candidate.hasSuffix(suffix) {
            if (try? files.read(Self.join(parent, candidate))) == data { return false }
        }
        let stamp = DateFormatter(); stamp.locale = Locale(identifier: "en_US_POSIX"); stamp.dateFormat = "yyyy-MM-dd HHmmss"
        let label = "\(stem) (conflict from \(ConflictCopyName.label(device) ?? "another device") \(stamp.string(from: modified ?? now())))"
        var candidate = label + suffix, attempt = 1
        let taken = Set(try files.names(parent))
        while taken.contains(candidate) { attempt += 1; candidate = "\(label) \(attempt)" + suffix }
        guard candidate.utf8.count <= 255 else { throw StorageFailure("conflict") }
        try files.create(Self.join(parent, candidate), data)
        return true
    }
}

/// Plain file access under one folder, for a process that is not the storage layer (the Mac helper).
public struct DiskConflictFiles {
    private let root: URL
    private let fm = FileManager.default
    public init(root: URL) { self.root = root.standardizedFileURL.resolvingSymlinksInPath() }

    /// The file a relative path names, or nil when the path leaves the root or passes through a link.
    public func url(for path: String) -> URL? {
        guard !path.hasPrefix("/"), !path.contains("\\"), !path.contains("\0") else { return nil }
        let segments = path.isEmpty ? [] : path.split(separator: "/", omittingEmptySubsequences: false).map(String.init)
        guard segments.allSatisfy({ !$0.isEmpty && $0 != "." && $0 != ".." }) else { return nil }
        var url = root
        for segment in segments {
            url.appendPathComponent(segment)
            if let type = try? fm.attributesOfItem(atPath: url.path)[.type] as? FileAttributeType, type == .typeSymbolicLink { return nil }
        }
        return url
    }
    private func resolved(_ path: String) throws -> URL {
        guard let url = url(for: path) else { throw StorageFailure("path-escape") }
        return url
    }
    public var files: ConflictHarvester.Files {
        ConflictHarvester.Files(
            isDirectory: { path in
                var directory: ObjCBool = false
                return fm.fileExists(atPath: try resolved(path).path, isDirectory: &directory) && directory.boolValue
            },
            names: { path in try fm.contentsOfDirectory(atPath: try resolved(path).path) },
            read: { path in try Data(contentsOf: try resolved(path), options: .mappedIfSafe) },
            create: { path, data in
                let url = try resolved(path)
                var failure: NSError?, thrown: Error?
                // Coordinated, so iCloud's own reader never sees a half-written copy.
                NSFileCoordinator().coordinate(writingItemAt: url, options: .forReplacing, error: &failure) { target in
                    let folder = target.deletingLastPathComponent()
                    let temporary = folder.appendingPathComponent(".docblocks-" + UUID().uuidString)
                    defer { try? fm.removeItem(at: temporary) }
                    do {
                        try fm.createDirectory(at: folder, withIntermediateDirectories: true)
                        try data.write(to: temporary, options: .withoutOverwriting)
                        // A hard link either creates the whole file or fails because one is already there.
                        guard link(temporary.path, target.path) == 0 else { throw StorageFailure(errno == EEXIST ? "already-exists" : "io") }
                    } catch { thrown = error }
                }
                if let failure { throw failure }
                if let thrown { throw thrown }
            })
    }
}
