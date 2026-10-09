// Appended only to a temporary test app. Never part of the production Xcode target.
import WebKit
import GezelRuntime

@MainActor enum DocBlocksAiSmoke {
    static var started = false
    static func start(_ controller: UIViewController?) {
        guard !started else { return }; started = true
        precondition(Bundle.main.bundleIdentifier == "com.bendyline.docblocks.mobile.tests")
        UIApplication.shared.isIdleTimerDisabled = true
        Task {
            defer { UIApplication.shared.isIdleTimerDisabled = false }
            var report: [String: Any] = ["runId": "RUN_ID"]
            do {
                guard let controller = controller as? CAPBridgeViewController else { throw problem("Missing Capacitor controller") }
                var web: WKWebView?
                for _ in 0..<150 {
                    if let candidate = controller.webView,
                       (try? await candidate.evaluateJavaScript("Boolean(window.docBlocksHost?.ai && document.querySelector('.db-shell'))")) as? Bool == true { web = candidate; break }
                    try await Task.sleep(nanoseconds: 200_000_000)
                }
                guard let web else { throw problem("Editor did not become ready") }
                let script = try String(contentsOf: Bundle.main.url(forResource: "ai-smoke", withExtension: "js", subdirectory: "public")!, encoding: .utf8)
                func phase(_ phase: String, _ modelId: String = "") async throws -> Any {
                    try await web.callAsyncJavaScript(script, arguments: ["phase": phase, "modelId": modelId], in: nil, contentWorld: .page) as Any
                }
                report["inspect"] = try await phase("inspect")
                if let snapshot = try? await web.takeSnapshot(configuration: nil), let png = snapshot.pngData() {
                    try png.write(to: output("ai-settings.png"))
                }
                let runtime = try GezelNativeRuntime.shared()
                let fixture = Bundle.main.url(forResource: "mobile-ai-fixture", withExtension: "gguf", subdirectory: "public")!
                let imported: [String: Any] = try await withCheckedThrowingContinuation { continuation in
                    runtime.importModel(NativeCall(resolve: { continuation.resume(returning: $0) }, reject: { message, _ in continuation.resume(throwing: problem(message)) }), from: fixture)
                }
                guard let model = imported["model"] as? [String: Any], let id = model["id"] as? String else { throw problem("Missing installed fixture identity") }
                report["generation"] = try await phase("generate", "llama-cpp:\(id)")
                let _: [String: Any] = try await withCheckedThrowingContinuation { continuation in
                    runtime.removeModel(NativeCall(["id": id], resolve: { continuation.resume(returning: $0) }, reject: { message, _ in continuation.resume(throwing: problem(message)) }))
                }
                if DOWNLOAD_MODEL {
                    report["realModel"] = try await phase("real")
                    if let snapshot = try? await web.takeSnapshot(configuration: nil), let png = snapshot.pngData() {
                        try png.write(to: output("ai-review.png"))
                    }
                }
                report["ok"] = true
            } catch { report["ok"] = false; report["error"] = String(describing: error) }
            do { try JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys]).write(to: output("ai-smoke.json"), options: .atomic) }
            catch { print("AI smoke report failed: \(error)") }
        }
    }
    static func output(_ name: String) -> URL { FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent(name) }
    static func problem(_ message: String) -> NSError { NSError(domain: "DocBlocksAiSmoke", code: 1, userInfo: [NSLocalizedDescriptionKey: message]) }
}
