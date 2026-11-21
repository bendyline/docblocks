import XCTest
@testable import DocBlocksStorage

/// iCloud's set-aside versions, scripted by file name.
private final class FakeConflictVersions: ConflictVersionSource {
    final class Version {
        let device: String?
        let modified: Date?
        let data: Data?
        var resolved = false
        init(_ text: String?, device: String? = "Mike's MacBook Pro", modified: Date? = Date(timeIntervalSince1970: 1_795_170_972)) {
            self.data = text.map { Data($0.utf8) }; self.device = device; self.modified = modified
        }
    }
    var versions: [String: [Version]] = [:]
    var discarded: [String] = []
    func hasUnresolvedConflicts(_ url: URL) -> Bool { versions[url.lastPathComponent]?.contains { !$0.resolved } == true }
    func losingVersions(of url: URL) -> [LosingVersion] {
        (versions[url.lastPathComponent] ?? []).filter { !$0.resolved }.map { version in
            LosingVersion(device: version.device, modified: version.modified,
                          read: { guard let data = version.data else { throw StorageFailure("io") }; return data },
                          markResolved: { version.resolved = true })
        }
    }
    func discardResolved(of url: URL) throws {
        discarded.append(url.lastPathComponent)
        versions[url.lastPathComponent]?.removeAll { $0.resolved }
    }
}

final class ConflictCopiesTests: XCTestCase {
    private var root: URL!
    private var versions: FakeConflictVersions!
    private var storage: Storage!
    private let fm = FileManager.default

    override func setUpWithError() throws {
        root = fm.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try fm.createDirectory(at: root, withIntermediateDirectories: false)
        versions = FakeConflictVersions()
        storage = try Storage(roots: ["local": root], conflicts: versions)
        try storage.register("cloud", root: root, cloud: true)
        _ = storage.request(["op": "open", "instanceId": "cloud", "providerId": "cloud", "label": "iCloud"])
    }
    override func tearDownWithError() throws { storage.shutdown(); try fm.removeItem(at: root) }

    private func put(_ path: String, _ text: String) throws {
        let url = root.appendingPathComponent(path)
        try fm.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data(text.utf8).write(to: url)
    }
    private func names(_ path: String) -> [String] { ((try? fm.contentsOfDirectory(atPath: root.appendingPathComponent(path).path)) ?? []).sorted() }
    private func text(_ path: String) throws -> String { try String(contentsOf: root.appendingPathComponent(path), encoding: .utf8) }
    private func read(_ path: String) -> [String: Any] {
        let begin = storage.request(["op": "readBegin", "instanceId": "cloud", "path": path])
        if let value = begin["value"] as? [String: Any], let token = value["transferId"] as? String {
            _ = storage.request(["op": "closeTransfer", "instanceId": "cloud", "transferId": token])
        }
        return begin
    }
    private func copies(_ directory: String) -> [String] { names(directory).filter { ConflictCopyName.parse($0) != nil } }

    // MARK: The shared name grammar

    private struct Fixture: Decodable {
        struct Name: Decodable { let name: String; let capturedAt: String; let origin: String; let source: Bool; let hash: String; let label: String?; let `extension`: String }
        struct Label: Decodable { let input: String; let output: String? }
        struct Hash: Decodable { let text: String; let hash: String }
        let names: [Name]; let rejected: [String]; let labels: [Label]; let hashes: [Hash]
    }
    private func fixture() throws -> Fixture {
        // Tests/DocBlocksStorageTests -> ios -> native -> mobile -> packages
        var packages = URL(fileURLWithPath: #filePath)
        for _ in 0..<6 { packages.deleteLastPathComponent() }
        let url = packages.appendingPathComponent("core/test/fixtures/conflict-copy-names.json")
        return try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: url))
    }
    func testNamesFormatAndParseLikeTheSharedVectors() throws {
        let iso = ISO8601DateFormatter()
        for vector in try fixture().names {
            let expected = ConflictCopyName(capturedAt: try XCTUnwrap(iso.date(from: vector.capturedAt)), origin: vector.origin, source: vector.source, hash: vector.hash, label: vector.label, fileExtension: vector.extension)
            XCTAssertEqual(expected.format(), vector.name)
            XCTAssertEqual(ConflictCopyName.parse(vector.name), expected, vector.name)
        }
    }
    func testNamesThatAreNotCopiesAreRejected() throws {
        for name in try fixture().rejected { XCTAssertNil(ConflictCopyName.parse(name), name) }
    }
    func testDeviceNamesAreMadeSafeLikeTheSharedVectors() throws {
        for label in try fixture().labels { XCTAssertEqual(ConflictCopyName.label(label.input), label.output, label.input.debugDescription) }
    }
    func testContentHashesMatchTheSharedVectors() throws {
        for hash in try fixture().hashes { XCTAssertEqual(ConflictCopyName.hash(Data(hash.text.utf8)), hash.hash) }
    }

    // MARK: Where a version belongs

    func testEachKindOfFileHasOnePlaceForItsVersions() throws {
        try put("Site/Page_files/page.md", "source"); try put("Site/Page.html", "<p>")
        let disk = DiskConflictFiles(root: root)
        let harvester = ConflictHarvester(files: disk.files, source: versions)
        XCTAssertEqual(try harvester.placement(for: "Notes/Unicorns.md"), .sidecar(directory: "Notes/Unicorns_files/conflicts", source: false))
        XCTAssertEqual(try harvester.placement(for: "Unicorns.MARKDOWN"), .sidecar(directory: "Unicorns_files/conflicts", source: false))
        XCTAssertEqual(try harvester.placement(for: "Site/Page_files/page.md"), .sidecar(directory: "Site/Page_files/conflicts", source: true))
        XCTAssertEqual(try harvester.placement(for: "Site/Page_files/photo.png"), .other(directory: "Site/Page_files/conflicts/other"))
        XCTAssertEqual(try harvester.placement(for: "Site/Page_files/.versions/1.md"), .other(directory: "Site/Page_files/conflicts/other"))
        XCTAssertEqual(try harvester.placement(for: "Site/Page.html"), .other(directory: "Site/Page_files/conflicts/other"))
        // A page with no sidecar must not gain one: that would turn it into a generated page.
        XCTAssertEqual(try harvester.placement(for: "Site/Plain.html"), .sibling)
        XCTAssertEqual(try harvester.placement(for: "data.json"), .sibling)
    }

    // MARK: Reading, listing and saving

    func testReadingADocumentMovesItsVersionsIntoTheSidecar() throws {
        try put("Notes/Unicorns.md", "winner")
        versions.versions["Unicorns.md"] = [.init("from the Mac"), .init("from the iPad", device: "iPad")]
        XCTAssertEqual(read("Notes/Unicorns.md")["ok"] as? Bool, true)

        XCTAssertEqual(names("Notes"), ["Unicorns.md", "Unicorns_files"])
        let kept = copies("Notes/Unicorns_files/conflicts")
        XCTAssertEqual(kept.count, 2)
        let mac = try XCTUnwrap(kept.first { $0.contains("(Mike's MacBook Pro)") })
        XCTAssertEqual(mac, "20261120T103612Z-sync-\(ConflictCopyName.hash(Data("from the Mac".utf8))) (Mike's MacBook Pro).md")
        XCTAssertEqual(try text("Notes/Unicorns_files/conflicts/\(mac)"), "from the Mac")
        // Not a git repository: no .gitignore for two devices to create at the same moment.
        XCTAssertEqual(names("Notes/Unicorns_files/conflicts").count, 2)
        XCTAssertEqual(try text("Notes/Unicorns.md"), "winner")
        XCTAssertEqual(versions.discarded, ["Unicorns.md"])
        XCTAssertFalse(versions.hasUnresolvedConflicts(root.appendingPathComponent("Notes/Unicorns.md")))
    }
    func testTheSameTextIsKeptOnceHoweverManyVersionsHoldIt() throws {
        try put("note.md", "winner")
        versions.versions["note.md"] = [.init("stale"), .init("stale", device: "iPad"), .init("winner")]
        _ = read("note.md")
        XCTAssertEqual(copies("note_files/conflicts").count, 1)
        // A later conflict that brings the same text back adds nothing.
        versions.versions["note.md"] = [.init("stale", device: "Another Mac", modified: Date(timeIntervalSince1970: 1_800_000_000))]
        _ = read("note.md")
        XCTAssertEqual(copies("note_files/conflicts").count, 1)
        XCTAssertEqual(versions.discarded, ["note.md", "note.md"])
    }
    func testAVersionThatCannotBeReadStaysWithICloudAndNothingFails() throws {
        try put("note.md", "winner")
        versions.versions["note.md"] = [.init(nil), .init("readable")]
        XCTAssertEqual(read("note.md")["ok"] as? Bool, true)
        XCTAssertEqual(copies("note_files/conflicts").count, 1)
        // Discarding would drop the unread version too.
        XCTAssertEqual(versions.discarded, [])
        XCTAssertTrue(versions.hasUnresolvedConflicts(root.appendingPathComponent("note.md")))
        let listing = storage.request(["op": "list", "instanceId": "cloud", "path": ""])
        XCTAssertEqual(listing["ok"] as? Bool, true)
    }
    func testListingAFolderKeepsVersionsOutOfTheDocumentList() throws {
        try put("a.md", "a"); try put("b.md", "b")
        versions.versions["a.md"] = [.init("other a")]
        let entries = try XCTUnwrap(storage.request(["op": "list", "instanceId": "cloud", "path": ""])["value"] as? [[String: Any]])
        XCTAssertEqual(entries.map { $0["name"] as? String }, ["a_files", "a.md", "b.md"])
        XCTAssertEqual(copies("a_files/conflicts").count, 1)
    }
    func testSavingKeepsTheVersionsSetAsideBeforeIt() throws {
        try put("note.md", "winner")
        versions.versions["note.md"] = [.init("other")]
        let bytes = Data("mine".utf8)
        let begin = storage.request(["op": "writeBegin", "instanceId": "cloud", "path": "note.md", "byteLength": bytes.count, "options": ["mode": "replace"]])
        let token = try XCTUnwrap(begin["value"] as? String)
        _ = storage.request(["op": "writeChunk", "instanceId": "cloud", "transferId": token, "offset": 0, "data": bytes.base64EncodedString()])
        XCTAssertEqual(storage.request(["op": "writeFinish", "instanceId": "cloud", "transferId": token])["ok"] as? Bool, true)
        XCTAssertEqual(try text("note.md"), "mine")
        XCTAssertEqual(copies("note_files/conflicts").count, 1)
    }
    func testDeletingOrMovingADocumentKeepsItsVersionsFirst() throws {
        try put("gone.md", "winner"); try put("moved.md", "winner")
        versions.versions["gone.md"] = [.init("other gone")]
        versions.versions["moved.md"] = [.init("other moved")]
        XCTAssertEqual(storage.request(["op": "remove", "instanceId": "cloud", "path": "gone.md", "options": [:]])["ok"] as? Bool, true)
        XCTAssertEqual(storage.request(["op": "move", "instanceId": "cloud", "oldPath": "moved.md", "newPath": "renamed.md", "options": [:]])["ok"] as? Bool, true)
        XCTAssertEqual(copies("gone_files/conflicts").count, 1)
        XCTAssertEqual(copies("moved_files/conflicts").count, 1)
        XCTAssertFalse(fm.fileExists(atPath: root.appendingPathComponent("gone.md").path))
        XCTAssertEqual(try text("renamed.md"), "winner")
    }
    func testDeviceStorageNeverLooksForVersions() throws {
        try put("note.md", "winner")
        versions.versions["note.md"] = [.init("other")]
        _ = storage.request(["op": "open", "instanceId": "device", "providerId": "local", "label": "Device"])
        let begin = storage.request(["op": "readBegin", "instanceId": "device", "path": "note.md"])
        XCTAssertEqual(begin["ok"] as? Bool, true)
        XCTAssertEqual(names(""), ["note.md"])
    }

    // MARK: Files that are not documents

    func testAnOutsideInSourceIsMarkedAndSidecarFilesAreKeptOutOfSight() throws {
        try put("Page.html", "<p>"); try put("Page_files/page.md", "source"); try put("Page_files/photo.png", "png")
        versions.versions["page.md"] = [.init("other source")]
        versions.versions["photo.png"] = [.init("other png")]
        versions.versions["Page.html"] = [.init("<p>other")]
        _ = read("Page_files/page.md"); _ = read("Page_files/photo.png"); _ = read("Page.html")

        let source = copies("Page_files/conflicts")
        XCTAssertEqual(source.count, 1)
        XCTAssertTrue(try XCTUnwrap(source.first).contains("-sync-s-"))
        let other = copies("Page_files/conflicts/other")
        XCTAssertEqual(other.count, 2)
        XCTAssertTrue(other.contains { $0.hasSuffix("(photo).png") })
        XCTAssertTrue(other.contains { $0.hasSuffix("(Page).html") })
        XCTAssertEqual(names(""), ["Page.html", "Page_files"])
    }
    func testAFileWithNoSidecarGetsOneVisibleCopy() throws {
        try put("data.json", "{}")
        versions.versions["data.json"] = [.init("{\"a\":1}")]
        _ = read("data.json")
        versions.versions["data.json"] = [.init("{\"a\":1}", device: "iPad", modified: Date(timeIntervalSince1970: 1_800_000_000))]
        _ = read("data.json")
        let all = names("")
        XCTAssertEqual(all.count, 2)
        XCTAssertTrue(all.contains { $0.hasPrefix("data (conflict from Mike's MacBook Pro ") && $0.hasSuffix(".json") })
        XCTAssertFalse(fm.fileExists(atPath: root.appendingPathComponent("data_files").path))
    }

    // MARK: The Mac helper's file access

    func testDiskAccessStaysInsideItsFolderAndNeverReplacesAFile() throws {
        let disk = DiskConflictFiles(root: root)
        XCTAssertNil(disk.url(for: "../escape.md")); XCTAssertNil(disk.url(for: "/absolute.md")); XCTAssertNil(disk.url(for: "a//b.md"))
        try fm.createSymbolicLink(at: root.appendingPathComponent("link"), withDestinationURL: root.deletingLastPathComponent())
        XCTAssertNil(disk.url(for: "link/escape.md"))
        try disk.files.create("deep/er/file.md", Data("one".utf8))
        XCTAssertThrowsError(try disk.files.create("deep/er/file.md", Data("two".utf8)))
        XCTAssertEqual(try text("deep/er/file.md"), "one")
        XCTAssertEqual(names("deep/er"), ["file.md"])
        XCTAssertEqual(try disk.files.isDirectory("deep"), true)
        XCTAssertEqual(try disk.files.isDirectory("deep/er/file.md"), false)
    }
    func testTheHelperHarvestsThroughPlainDiskAccess() throws {
        try put("Notes/Unicorns.md", "winner")
        versions.versions["Unicorns.md"] = [.init("from the phone", device: "Mike's iPhone")]
        let disk = DiskConflictFiles(root: root)
        let outcome = ConflictHarvester(files: disk.files, source: versions).harvest("Notes/Unicorns.md", at: try XCTUnwrap(disk.url(for: "Notes/Unicorns.md")))
        XCTAssertEqual(outcome.kept, 1); XCTAssertEqual(outcome.pending, 0)
        XCTAssertEqual(copies("Notes/Unicorns_files/conflicts").count, 1)
        XCTAssertEqual(names("Notes/Unicorns_files/conflicts").count, 1)
    }
    func testCopiesAreHiddenFromGitOnlyInsideARepository() throws {
        try fm.createDirectory(at: root.appendingPathComponent(".git"), withIntermediateDirectories: false)
        try put("Notes/Unicorns.md", "winner"); try put("Page.html", "<p>"); try put("Page_files/page.md", "source"); try put("Page_files/photo.png", "png")
        versions.versions["Unicorns.md"] = [.init("other")]
        versions.versions["photo.png"] = [.init("other png")]
        _ = read("Notes/Unicorns.md"); _ = read("Page_files/photo.png")
        XCTAssertEqual(try text("Notes/Unicorns_files/conflicts/.gitignore"), "*\n")
        // One file covers the folder and what is kept out of sight inside it.
        XCTAssertEqual(try text("Page_files/conflicts/.gitignore"), "*\n")
        XCTAssertFalse(fm.fileExists(atPath: root.appendingPathComponent("Page_files/conflicts/other/.gitignore").path))

        // The Mac helper looks above the folder too: a workspace can be a folder inside a repository.
        let nested = root.appendingPathComponent("Notes")
        versions.versions["Unicorns.md"] = [.init("another", device: "iPad")]
        let service = CloudHelperService(cloud: SyncedCloud(), conflicts: versions)
        try fm.removeItem(at: root.appendingPathComponent("Notes/Unicorns_files/conflicts/.gitignore"))
        XCTAssertEqual((service.handle(["op": "harvest", "root": nested.path, "path": "Unicorns.md"])["value"] as? [String: Int])?["kept"], 1)
        XCTAssertEqual(try text("Notes/Unicorns_files/conflicts/.gitignore"), "*\n")
    }

    // MARK: What the Mac app asks its helper

    private final class SyncedCloud: CloudState {
        var freshness: [String: CloudFreshness] = [:]
        var local: Set<String> = []
        func freshness(of url: URL) -> CloudFreshness? { freshness[url.lastPathComponent] ?? .current }
        func downloadFailed(for url: URL) -> Bool { false }
        func startDownloading(_ url: URL) throws {}
        func upload(of url: URL) -> CloudUpload? { local.contains(url.lastPathComponent) ? nil : CloudUpload(uploaded: true, uploading: false) }
    }
    func testTheHelperReportsWhichFilesNeedAttentionWithoutChangingAnything() throws {
        try put("Notes/Unicorns.md", "winner"); try put("Notes/quiet.md", "quiet"); try put(".hidden/secret.md", "x")
        versions.versions["Unicorns.md"] = [.init("other")]
        versions.versions["secret.md"] = [.init("other")]
        let cloud = SyncedCloud(); cloud.freshness["quiet.md"] = .stale
        let service = CloudHelperService(cloud: cloud, conflicts: versions)

        let scan = service.handle(["id": 7, "op": "scan", "root": root.path])
        XCTAssertEqual(scan["ok"] as? Bool, true); XCTAssertEqual(scan["id"] as? Int, 7)
        let found = try XCTUnwrap(scan["value"] as? [String: Any])
        XCTAssertEqual(found["conflicted"] as? [String], ["Notes/Unicorns.md"])
        XCTAssertEqual(found["synced"] as? Bool, true); XCTAssertEqual(found["truncated"] as? Bool, false)

        let status = service.handle(["op": "status", "paths": [root.appendingPathComponent("Notes/Unicorns.md").path, root.appendingPathComponent("Notes/quiet.md").path]])
        let items = try XCTUnwrap(status["value"] as? [[String: Any]])
        XCTAssertEqual(items.map { $0["conflicts"] as? Bool }, [true, false])
        XCTAssertEqual(items.map { $0["download"] as? String }, ["current", "stale"])
        XCTAssertEqual(items.map { $0["uploaded"] as? Bool }, [true, true])
        XCTAssertEqual(names("Notes"), ["Unicorns.md", "quiet.md"])
    }
    func testTheHelperSaysWhenAFolderIsNotSynced() throws {
        try put("note.md", "text")
        let cloud = SyncedCloud(); cloud.local = [root.lastPathComponent, "note.md"]
        let service = CloudHelperService(cloud: cloud, conflicts: versions)
        XCTAssertEqual((service.handle(["op": "scan", "root": root.path])["value"] as? [String: Any])?["synced"] as? Bool, false)
        let status = try XCTUnwrap(service.handle(["op": "status", "paths": [root.appendingPathComponent("note.md").path]])["value"] as? [[String: Any]])
        XCTAssertEqual(status.first?["synced"] as? Bool, false)
        XCTAssertNil(status.first?["download"])
    }
    func testTheHelperKeepsVersionsOnRequestAndRefusesPathsOutsideItsFolder() throws {
        try put("Notes/Unicorns.md", "winner")
        versions.versions["Unicorns.md"] = [.init("other"), .init(nil)]
        let service = CloudHelperService(cloud: SyncedCloud(), conflicts: versions)
        let kept = service.handle(["op": "harvest", "root": root.path, "path": "Notes/Unicorns.md"])
        XCTAssertEqual(kept["value"] as? [String: Int], ["kept": 1, "duplicates": 0, "pending": 1])
        XCTAssertEqual(copies("Notes/Unicorns_files/conflicts").count, 1)

        func code(_ request: [String: Any]) -> String? { service.handle(request)["code"] as? String }
        XCTAssertEqual(code(["op": "harvest", "root": root.path, "path": "../escape.md"]), "invalid-path")
        XCTAssertEqual(code(["op": "harvest", "root": root.path, "path": "missing.md"]), "not-found")
        XCTAssertEqual(code(["op": "harvest", "root": root.path, "path": "Notes"]), "type-mismatch")
        XCTAssertEqual(code(["op": "harvest", "root": "relative", "path": "a.md"]), "corrupt")
        XCTAssertEqual(code(["op": "scan", "root": root.appendingPathComponent("missing").path]), "not-found")
        XCTAssertEqual(code(["op": "format-disk"]), "not-supported")
        XCTAssertEqual(code(["op": "status", "paths": Array(repeating: "/a", count: 257)]), "corrupt")
        XCTAssertEqual(service.handle("not an object")["ok"] as? Bool, false)
    }
}

final class ChangeThrottleTests: XCTestCase {
    func testABurstBecomesOneReportAndTheLastMomentIsNeverDropped() {
        let queue = DispatchQueue(label: "throttle-test")
        var reports = 0
        let throttle = ChangeThrottle(interval: 0.15, queue: queue) { reports += 1 }
        for _ in 0..<5 { throttle.note() }
        queue.sync {}
        XCTAssertEqual(queue.sync { reports }, 1)
        // These arrive inside the interval: held, then reported once.
        throttle.note(); throttle.note()
        queue.sync {}
        XCTAssertEqual(queue.sync { reports }, 1)
        Thread.sleep(forTimeInterval: 0.3)
        XCTAssertEqual(queue.sync { reports }, 2)
    }
    func testNothingIsReportedWhileStopped() {
        let queue = DispatchQueue(label: "throttle-test")
        var reports = 0
        let throttle = ChangeThrottle(interval: 0.05, queue: queue) { reports += 1 }
        throttle.stop(); throttle.note()
        Thread.sleep(forTimeInterval: 0.12)
        XCTAssertEqual(queue.sync { reports }, 0)
        throttle.start(); throttle.note()
        queue.sync {}
        XCTAssertEqual(queue.sync { reports }, 1)
    }
    func testAHeldReportIsDroppedWhenStoppedBeforeItIsDue() {
        let queue = DispatchQueue(label: "throttle-test")
        var reports = 0
        let throttle = ChangeThrottle(interval: 0.1, queue: queue) { reports += 1 }
        throttle.note(); throttle.note(); throttle.stop()
        Thread.sleep(forTimeInterval: 0.25)
        XCTAssertEqual(queue.sync { reports }, 1)
    }
}
