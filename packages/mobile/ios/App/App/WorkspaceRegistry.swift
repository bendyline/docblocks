import Foundation

/// File-provider bookmarks stay native. Unavailable grants remain listed; opening them fails visibly.
final class WorkspaceRegistry {
    struct Workspace {
        let id: String
        let name: String
        let bookmark: Data
        var url: URL?
        var scoped: Bool
        var info: [String: String] { ["id": id, "name": name, "rootPath": "Files / " + name] }
    }
    private let file: URL
    private(set) var workspaces: [Workspace] = []
    init() throws {
        let support = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        file = support.appendingPathComponent("workspaces.plist")
        do {
            let data = try Data(contentsOf: file)
            guard data.count <= 4 * 1024 * 1024, let records = try PropertyListSerialization.propertyList(from: data, format: nil) as? [[String: Any]], records.count <= 63 else { throw StorageFailure("corrupt") }
            var ids = Set<String>()
            for record in records {
                guard Set(record.keys) == ["id", "name", "bookmark"], let id = record["id"] as? String, UUID(uuidString: id) != nil, ids.insert(id).inserted,
                      let name = record["name"] as? String, !name.isEmpty, name.utf16.count <= 1024,
                      let bookmark = record["bookmark"] as? Data, bookmark.count <= 65536 else { throw StorageFailure("corrupt") }
                var resolved: URL?, scoped = false, stale = false
                do {
                    let url = try URL(resolvingBookmarkData: bookmark, options: [.withoutUI], relativeTo: nil, bookmarkDataIsStale: &stale)
                    scoped = url.startAccessingSecurityScopedResource()
                    if scoped { resolved = url }
                } catch { /* Keep the grant visible so the user can reconnect its provider. */ }
                workspaces.append(Workspace(id: id, name: name, bookmark: bookmark, url: resolved, scoped: scoped))
            }
        } catch {
            let error = error as NSError
            if error.domain != NSCocoaErrorDomain || ![NSFileNoSuchFileError, NSFileReadNoSuchFileError].contains(error.code) { throw error }
        }
    }
    deinit { for workspace in workspaces where workspace.scoped { workspace.url?.stopAccessingSecurityScopedResource() } }
    func add(_ url: URL) throws -> Workspace {
        guard workspaces.count < 63, url.startAccessingSecurityScopedResource() else { throw StorageFailure("permission-denied") }
        do {
            let canonical = url.standardizedFileURL.resolvingSymlinksInPath()
            if let existing = workspaces.first(where: { $0.url?.standardizedFileURL.resolvingSymlinksInPath() == canonical }) { url.stopAccessingSecurityScopedResource(); return existing }
            let bookmark = try url.bookmarkData(options: [.minimalBookmark], includingResourceValuesForKeys: nil, relativeTo: nil)
            guard bookmark.count <= 65536 else { throw StorageFailure("quota-exceeded") }
            let workspace = Workspace(id: UUID().uuidString, name: url.lastPathComponent, bookmark: bookmark, url: url, scoped: true)
            try persist(workspaces + [workspace]); workspaces.append(workspace); return workspace
        } catch { url.stopAccessingSecurityScopedResource(); throw error }
    }
    func remove(_ id: String) throws {
        let remaining = workspaces.filter { $0.id != id }; try persist(remaining)
        for workspace in workspaces where workspace.id == id && workspace.scoped { workspace.url?.stopAccessingSecurityScopedResource() }
        workspaces = remaining
    }
    private func persist(_ workspaces: [Workspace]) throws {
        let records: [[String: Any]] = workspaces.map { ["id": $0.id, "name": $0.name, "bookmark": $0.bookmark] }
        try PropertyListSerialization.data(fromPropertyList: records, format: .binary, options: 0).write(to: file, options: .atomic)
    }
}
