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
