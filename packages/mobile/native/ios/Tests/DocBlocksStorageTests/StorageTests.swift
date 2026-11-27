import XCTest
@testable import DocBlocksStorage

final class StorageTests: XCTestCase {
    private var root: URL!
    private var storage: Storage!
    override func setUpWithError() throws {
        root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false)
        storage = try Storage(roots: ["local": root])
        _ = storage.request(["op": "open", "instanceId": "test", "providerId": "local", "label": "Test"])
    }
    override func tearDownWithError() throws { storage.shutdown(); try FileManager.default.removeItem(at: root) }
    func testSymlinksCannotEscapeTheRegisteredRoot() throws {
        try FileManager.default.createSymbolicLink(at: root.appendingPathComponent("escape"), withDestinationURL: root.deletingLastPathComponent())
        let response = storage.request(["op": "stat", "instanceId": "test", "path": "escape"])
        XCTAssertEqual((response["error"] as? [String: Any])?["code"] as? String, "path-escape")
    }
    func testWireRequestsRejectUnknownFieldsAndBooleanLengths() throws {
        let malformed: [[String: Any]] = [
            ["op": "stat", "instanceId": "test", "path": "", "extra": true],
            ["op": "writeBegin", "instanceId": "test", "path": "note.md", "byteLength": true, "options": [:]],
            ["op": "stat", "instanceId": "test", "path": "../escape"]
        ]
        for request in malformed { XCTAssertEqual(storage.request(request)["ok"] as? Bool, false) }
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: root.path), [])
    }
    func testTransfersAreOwnedAndIncompleteWritesLeaveNoFile() throws {
        let begin = storage.request(["op": "writeBegin", "instanceId": "test", "path": "note.md", "byteLength": 8, "options": [:]])
        let token = try XCTUnwrap(begin["value"] as? String)
        _ = storage.request(["op": "open", "instanceId": "other", "providerId": "local", "label": "Other"])
        let stolen = storage.request(["op": "writeChunk", "instanceId": "other", "transferId": token, "offset": 0, "data": "YWJj"])
        XCTAssertEqual((stolen["error"] as? [String: Any])?["code"] as? String, "permission-denied")
        XCTAssertEqual(storage.request(["op": "writeFinish", "instanceId": "test", "transferId": token])["ok"] as? Bool, false)
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: root.path), [])
    }
    func testReplacedRootCannotBecomeNewAuthority() throws {
        let moved = root.deletingLastPathComponent().appendingPathComponent(UUID().uuidString)
        try FileManager.default.moveItem(at: root, to: moved)
        defer { try? FileManager.default.removeItem(at: moved) }
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false)
        let response = storage.request(["op": "stat", "instanceId": "test", "path": ""])
        XCTAssertEqual((response["error"] as? [String: Any])?["code"] as? String, "permission-denied")
    }
    func testRevokingWorkspaceRevokesItsExistingTransfers() throws {
        let begin = storage.request(["op": "writeBegin", "instanceId": "test", "path": "pending.md", "byteLength": 3, "options": [:]])
        let token = try XCTUnwrap(begin["value"] as? String)
        storage.unregister("local")
        let response = storage.request(["op": "writeChunk", "instanceId": "test", "transferId": token, "offset": 0, "data": "YWJj"])
        XCTAssertEqual((response["error"] as? [String: Any])?["code"] as? String, "disposed")
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: root.path), [])
    }
    func testCloudStubsAreListedUnderTheirNamesWithoutDownloading() throws {
        let stub = try PropertyListSerialization.data(fromPropertyList: ["NSURLNameKey": "note.md", "NSURLFileSizeKey": 42], format: .binary, options: 0)
        try stub.write(to: root.appendingPathComponent(".note.md.icloud"))
        try Data("kept".utf8).write(to: root.appendingPathComponent("local.md"))
        try storage.register("cloud", root: root, cloud: true)
        _ = storage.request(["op": "open", "instanceId": "cloud", "providerId": "cloud", "label": "iCloud"])
        let entries = try XCTUnwrap(storage.request(["op": "list", "instanceId": "cloud", "path": ""])["value"] as? [[String: Any]])
        XCTAssertEqual(entries.map { $0["name"] as? String }, ["local.md", "note.md"])
        let note = try XCTUnwrap(entries.last)
        XCTAssertEqual(note["kind"] as? String, "file"); XCTAssertEqual(note["size"] as? Int, 42)
        XCTAssertTrue((note["version"] as? String)?.hasPrefix("icloud-") == true)
        let begin = storage.request(["op": "writeBegin", "instanceId": "cloud", "path": "note.md", "byteLength": 1, "options": ["mode": "create"]])
        let token = try XCTUnwrap(begin["value"] as? String)
        _ = storage.request(["op": "writeChunk", "instanceId": "cloud", "transferId": token, "offset": 0, "data": "eA=="])
        XCTAssertEqual(storage.request(["op": "writeFinish", "instanceId": "cloud", "transferId": token])["ok"] as? Bool, false)
        let snapshot = storage.request(["op": "snapshot", "instanceId": "cloud"])
        XCTAssertEqual((snapshot["error"] as? [String: Any])?["code"] as? String, "busy")
        // Device storage keeps the literal name and never treats it as a cloud item.
        let device = try XCTUnwrap(storage.request(["op": "list", "instanceId": "test", "path": ""])["value"] as? [[String: Any]])
        XCTAssertEqual(device.map { $0["name"] as? String }, [".note.md.icloud", "local.md"])
        XCTAssertTrue(FileManager.default.fileExists(atPath: root.appendingPathComponent(".note.md.icloud").path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: root.appendingPathComponent("note.md").path))
    }
    // MARK: A local copy that iCloud has already replaced

    /// Opens `note.md` in a cloud root whose iCloud state is scripted by the test.
    private func openStale(_ cloud: FakeCloudState, _ waits: CloudWaits) throws -> Storage {
        try Data("old".utf8).write(to: root.appendingPathComponent("note.md"))
        cloud.freshness["note.md"] = .stale
        let synced = try Storage(roots: ["local": root], cloud: cloud, waits: waits)
        try synced.register("cloud", root: root, cloud: true)
        _ = synced.request(["op": "open", "instanceId": "cloud", "providerId": "cloud", "label": "iCloud"])
        return synced
    }
    private func quickWaits() -> CloudWaits {
        var waits = CloudWaits(); waits.poll = 0.01; waits.staleRead = 0.05; waits.staleChange = 0.05; waits.staleGrace = 60
        return waits
    }
    private func version(_ storage: Storage, _ path: String) throws -> String {
        try XCTUnwrap((storage.request(["op": "stat", "instanceId": "cloud", "path": path])["value"] as? [String: Any])?["version"] as? String)
    }
    private func replace(_ storage: Storage, _ path: String, with text: String, expecting version: String) throws -> [String: Any] {
        let bytes = Data(text.utf8)
        let begin = storage.request(["op": "writeBegin", "instanceId": "cloud", "path": path, "byteLength": bytes.count, "options": ["mode": "replace", "expectedVersion": version]])
        let token = try XCTUnwrap(begin["value"] as? String)
        _ = storage.request(["op": "writeChunk", "instanceId": "cloud", "transferId": token, "offset": 0, "data": bytes.base64EncodedString()])
        return storage.request(["op": "writeFinish", "instanceId": "cloud", "transferId": token])
    }
    private func text(_ name: String) throws -> String { try String(contentsOf: root.appendingPathComponent(name), encoding: .utf8) }
    private func code(_ response: [String: Any]) -> String? { (response["error"] as? [String: Any])?["code"] as? String }

    func testReadingAStaleFileWaitsForTheNewerVersion() throws {
        let cloud = FakeCloudState()
        cloud.onStart = { [root] name in
            try? Data("new".utf8).write(to: root!.appendingPathComponent(name)); cloud.freshness[name] = .current
        }
        let synced = try openStale(cloud, quickWaits()); defer { synced.shutdown() }
        let read = try XCTUnwrap(synced.request(["op": "readBegin", "instanceId": "cloud", "path": "note.md"])["value"] as? [String: Any])
        let token = try XCTUnwrap(read["transferId"] as? String)
        let chunk = try XCTUnwrap(synced.request(["op": "readChunk", "instanceId": "cloud", "transferId": token, "offset": 0])["value"] as? String)
        XCTAssertEqual(Data(base64Encoded: chunk), Data("new".utf8))
        XCTAssertEqual(cloud.started, ["note.md"])
    }
    func testReadingAStaleFileFallsBackToTheLocalCopy() throws {
        let cloud = FakeCloudState()
        let synced = try openStale(cloud, quickWaits()); defer { synced.shutdown() }
        let read = try XCTUnwrap(synced.request(["op": "readBegin", "instanceId": "cloud", "path": "note.md"])["value"] as? [String: Any])
        XCTAssertEqual((read["entry"] as? [String: Any])?["size"] as? Int, 3)
        XCTAssertEqual(cloud.started, ["note.md"])
    }
    func testCheckingAStaleFileAsksForTheNewerVersionWithoutWaiting() throws {
        let cloud = FakeCloudState()
        var waits = quickWaits(); waits.staleRead = 30; waits.staleChange = 30
        let synced = try openStale(cloud, waits); defer { synced.shutdown() }
        let started = Date()
        _ = try version(synced, "note.md")
        XCTAssertLessThan(Date().timeIntervalSince(started), 5)
        XCTAssertEqual(cloud.started, ["note.md"])
    }
    func testAStaleFileIsNotOverwrittenWhileTheNewerVersionIsArriving() throws {
        let cloud = FakeCloudState()
        let synced = try openStale(cloud, quickWaits()); defer { synced.shutdown() }
        let response = try replace(synced, "note.md", with: "mine", expecting: try version(synced, "note.md"))
        XCTAssertEqual(code(response), "busy")
        XCTAssertEqual((response["error"] as? [String: Any])?["retryable"] as? Bool, true)
        XCTAssertEqual(try text("note.md"), "old")
        // Moving or deleting it would also act on old content.
        XCTAssertEqual(code(synced.request(["op": "remove", "instanceId": "cloud", "path": "note.md", "options": [:]])), "busy")
        XCTAssertEqual(code(synced.request(["op": "move", "instanceId": "cloud", "oldPath": "note.md", "newPath": "moved.md", "options": [:]])), "busy")
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: root.path), ["note.md"])
    }
    func testAWriteBasedOnStaleContentBecomesAConflictOnceTheNewerVersionArrives() throws {
        let cloud = FakeCloudState()
        let synced = try openStale(cloud, quickWaits()); defer { synced.shutdown() }
        let old = try version(synced, "note.md")
        cloud.onStart = { [root] name in
            try? Data("new".utf8).write(to: root!.appendingPathComponent(name)); cloud.freshness[name] = .current
        }
        XCTAssertEqual(code(try replace(synced, "note.md", with: "mine", expecting: old)), "conflict")
        XCTAssertEqual(try text("note.md"), "new")
    }
    func testAStaleFileCanStillBeSavedOffline() throws {
        let cloud = FakeCloudState(); cloud.failed = ["note.md"]
        let synced = try openStale(cloud, quickWaits()); defer { synced.shutdown() }
        XCTAssertEqual(try replace(synced, "note.md", with: "mine", expecting: try version(synced, "note.md"))["ok"] as? Bool, true)
        XCTAssertEqual(try text("note.md"), "mine")
    }
    func testAStaleFileIsNeverRefusedIndefinitely() throws {
        let cloud = FakeCloudState()
        var waits = quickWaits(); waits.staleGrace = 0.2
        let synced = try openStale(cloud, waits); defer { synced.shutdown() }
        let old = try version(synced, "note.md")
        XCTAssertEqual(code(try replace(synced, "note.md", with: "mine", expecting: old)), "busy")
        Thread.sleep(forTimeInterval: 0.25)
        XCTAssertEqual(try replace(synced, "note.md", with: "mine", expecting: old)["ok"] as? Bool, true)
        XCTAssertEqual(try text("note.md"), "mine")
    }
    func testExportStagingRequiresCompleteOrderedDataAndCancels() throws {
        let staging = try ExportStaging(root: root.appendingPathComponent("exports"))
        let token = try staging.begin(filename: "report.md", size: 3)
        XCTAssertThrowsError(try staging.append(token, offset: 1, base64: "YWJj"))
        XCTAssertThrowsError(try staging.finish(token))
        try staging.append(token, offset: 0, base64: "YWJj")
        let file = try staging.finish(token)
        XCTAssertEqual(try String(contentsOf: file), "abc")
        try staging.cancel(token); try staging.cancel(token)
        XCTAssertFalse(FileManager.default.fileExists(atPath: file.path))
    }
}

/// iCloud's view of a root, scripted by file name. Storage calls it under its own lock.
private final class FakeCloudState: CloudState {
    var freshness: [String: CloudFreshness] = [:]
    var failed: Set<String> = []
    var started: [String] = []
    var onStart: ((String) -> Void)?
    func freshness(of url: URL) -> CloudFreshness? { freshness[url.lastPathComponent] }
    func downloadFailed(for url: URL) -> Bool { failed.contains(url.lastPathComponent) }
    func startDownloading(_ url: URL) throws { started.append(url.lastPathComponent); onStart?(url.lastPathComponent) }
}
